-- Foundation for real vendor payments: money that has LEFT but not ARRIVED.
--
-- Today "record a payment" means the human already paid — wrote the cheque,
-- pushed the transfer — so posting DR 2110 AP / CR 1020 Cash at that moment is
-- correct and stays unchanged.
--
-- A payment the SYSTEM originates is different, and the difference is the
-- whole reason this migration exists:
--
--   * the money does not leave for 1-3 business days;
--   * it can come BACK — NSF, closed account, wrong routing number — days
--     later, sometimes up to 60 days for an unauthorised consumer debit;
--   * during that window the vendor has not been paid and the cash has not
--     left, and the books must say exactly that.
--
-- Crediting Cash at submission would show money gone that is still in the
-- account, make the bank reconciliation impossible for the whole window, and
-- leave nothing to reverse when a payment is returned. The standard treatment
-- is a clearing account:
--
--   submit   DR 2110 Accounts payable      CR 2115 Payments in transit
--   settle   DR 2115 Payments in transit   CR 1020 Cash
--   returned DR 2115 Payments in transit   CR 2110 Accounts payable
--
-- Every step balances, the vendor goes back to being owed on a return, and
-- 2115 is a running list of what is in flight — which is also the honest
-- answer to "has the supplier been paid yet?".
--
-- 2115 is useful before any provider exists: a cheque written today and cashed
-- next week is the same shape.

-- ⚠️ Per-tenant loop with the GUC set, NOT a single set-based INSERT.
--
-- On Cloud SQL the `postgres` role is not a true superuser, so FORCE RLS binds
-- even the table owner — the fact the whole isolation model rests on. A plain
-- `INSERT INTO chart_of_accounts SELECT ... FROM tenants` therefore fails with
-- "new row violates row-level security policy", because the WITH CHECK has no
-- tenant in scope to compare against.
--
-- It passes locally, where postgres IS a superuser and sails straight through.
-- That asymmetry is exactly how a DATA migration gets to production before
-- anyone finds out. Set the scope per tenant and the two behave the same.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);
    INSERT INTO chart_of_accounts (tenant_id, code, name, type, section, description)
    SELECT t.id, '2115', 'Payments in transit', 'liability',
           '2000-2990 Liabilities and Owners'' Equity',
           'Vendor payments sent but not yet settled. Cleared to cash on '
           'settlement, or back to accounts payable if the payment is returned.'
     WHERE NOT EXISTS (
       SELECT 1 FROM chart_of_accounts c
        WHERE c.tenant_id = t.id AND c.code = '2115'
     );
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END $$;

-- ------------------------------------------------------- payment lifecycle
-- bill_payments has been append-only history of payments ALREADY made. A
-- system-originated payment needs a state machine, because it can fail after
-- we have accepted it.
ALTER TABLE bill_payments
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'settled'
    CHECK (status IN ('pending', 'settled', 'returned', 'cancelled')),
  -- Which rail moved it. 'manual' = a human paid outside the system, which is
  -- every row that exists today and stays the default.
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'manual',
  -- The provider's own id, for reconciliation and support tickets.
  ADD COLUMN IF NOT EXISTS provider_ref text,
  ADD COLUMN IF NOT EXISTS settled_on date,
  -- Why a returned payment came back, in the provider's words.
  ADD COLUMN IF NOT EXISTS failure_reason text,
  -- The settlement/reversal entry, so the audit trail links both halves.
  ADD COLUMN IF NOT EXISTS settlement_entry_id uuid;

-- Existing rows are settled manual payments by definition — they record money
-- that already moved. The defaults above already say so; this is explicit for
-- anyone reading the data later.
UPDATE bill_payments SET status = 'settled', provider = 'manual'
 WHERE status IS NULL OR provider IS NULL;

-- One provider payment maps to exactly one bill_payments row. Without this a
-- retried webhook or a double submit posts the money twice — the same
-- at-least-once delivery problem the Stripe invoice path had.
CREATE UNIQUE INDEX IF NOT EXISTS bill_payments_provider_ref_uniq
  ON bill_payments (tenant_id, provider, provider_ref)
  WHERE provider_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS bill_payments_pending_idx
  ON bill_payments (tenant_id, status) WHERE status = 'pending';

COMMENT ON COLUMN bill_payments.status IS
  'manual payments are born settled (the human already paid). Provider '
  'payments go pending -> settled, or pending -> returned, which posts a '
  'reversal putting the bill back on the payables list.';

-- ------------------------------------------------- per-tenant payment setup
-- A bill-pay partner onboards each BUSINESS (KYB) and issues an account id.
-- Nothing here holds bank credentials: the partner holds those, which is the
-- entire reason for using one.
CREATE TABLE IF NOT EXISTS bill_pay_accounts (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  provider_ref  text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended')),
  connected_by  text NOT NULL,
  connected_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bill_pay_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_pay_accounts FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bill_pay_accounts
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
-- Paying vendors is a financials-department action, and the DB says so rather
-- than trusting whichever route happens to reach it.
CREATE POLICY bill_pay_department ON bill_pay_accounts
  AS RESTRICTIVE FOR ALL
  USING (app.can_see_department('financials'))
  WITH CHECK (app.can_see_department('financials'));
GRANT SELECT, INSERT, UPDATE ON bill_pay_accounts TO app_user;

COMMENT ON TABLE bill_pay_accounts IS
  'Per-tenant onboarding with a licensed bill-pay partner. Holds the partner''s '
  'account reference only — never bank credentials; the partner holds those, '
  'which is the point of using one.';
