-- 0054 — credit cards are not bank accounts, and money moves between your own.
--
-- Three things had to be true before a live bank feed of any kind would be
-- useful, and none of them depend on a vendor. Building them first is also
-- what keeps the feed integration itself small: the ledger must never know
-- whether a transaction arrived from Teller, from Plaid, or from a CSV
-- somebody dragged onto the screen.

-- ═════════════════════════════════════════ 1. what KIND of account it is
-- ⛔ A CREDIT CARD IS A LIABILITY, NOT AN ASSET.
--
-- Money leaving a checking account credits an asset. A charge on a card
-- credits a LIABILITY — it increases what the shop owes. The schema treated
-- every connected account as cash (gl_account_code defaulting to 1020), which
-- on a card produces a balance sheet showing negative cash and no card debt
-- at all. That is not a display bug; it is a wrong balance sheet, and it is
-- the one a bank and a surety both read first.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'checking'
  CHECK (kind IN ('checking','savings','credit-card','line-of-credit','loan'));

-- Statement sign conventions differ per institution and per account type. A
-- card statement may show a purchase as POSITIVE (the amount charged) while a
-- checking statement shows a debit as negative. Rather than guessing per
-- bank, the account records which convention its statements use, and the
-- importer normalises to the product's own rule: NEGATIVE is always "the
-- shop's position got worse" — money out of checking, or more owed on a card.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS charges_are_positive boolean NOT NULL DEFAULT false;

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- ── the account a card actually posts to ─────────────────────────────────
-- ⛔ THE NAHB CHART HAS NO CREDIT-CARD ACCOUNT. It has "Line of credit
-- payable" (2200) and a general "Accounts payable, other" (2190), and
-- neither is right: card debt belongs on its own line where a banker and a
-- surety can see it. Seeded for every EXISTING tenant here, and added to the
-- seed CSV so tenants created afterwards get it too — the gap migration 0037
-- had to fix for account 3138, avoided this time.
INSERT INTO chart_of_accounts (tenant_id, code, name, type, section, description, tag)
SELECT t.id, '2150', 'Credit cards payable', 'liability',
       '2000-2990 Liabilities and Owners'' Equity',
       'Outstanding balances on business credit cards', 'liability'
  FROM tenants t
 WHERE EXISTS (SELECT 1 FROM chart_of_accounts a WHERE a.tenant_id = t.id)
ON CONFLICT (tenant_id, code) DO NOTHING;

-- ═════════════════════════════════════════ 2. transfers between own accounts
-- The moment a shop has two accounts, "I paid the credit card from checking"
-- appears on BOTH feeds. Without a transfer answer it gets coded as an
-- expense on one side and income on the other, and the P&L is wrong by twice
-- the payment — in the direction that makes the shop look more profitable,
-- which is the direction nobody questions.
--
-- The two sides are matched to each other so a later reader can see they are
-- one movement, and so the second side cannot be answered twice.
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS transfer_pair_id uuid;
CREATE INDEX IF NOT EXISTS bt_transfer_pair_idx
  ON bank_transactions(tenant_id, transfer_pair_id)
  WHERE transfer_pair_id IS NOT NULL;

-- 'transfer' joins the closed set of statuses. Dropped by lookup.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'bank_transactions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%categorized%'
     AND pg_get_constraintdef(oid) ILIKE '%personal%';
  IF cname IS NULL THEN
    RAISE EXCEPTION 'bank_transactions status CHECK not found — did 0009 change?';
  END IF;
  EXECUTE format('ALTER TABLE bank_transactions DROP CONSTRAINT %I', cname);
END $$;
ALTER TABLE bank_transactions ADD CONSTRAINT bt_status_check
  CHECK (status IN ('pending','matched','categorized','personal','excluded','transfer'));

-- Same for the correction log's action set.
ALTER TABLE bank_txn_resolutions DROP CONSTRAINT IF EXISTS btr_action_check;
ALTER TABLE bank_txn_resolutions ADD CONSTRAINT btr_action_check
  CHECK (action IN ('expense','job-cost','personal','exclude','unmatch','split','transfer'));

-- ═════════════════════════════════════════ 3. the feed connection
-- Provider-agnostic ON PURPOSE. QuickBooks Online's own feeds run on Plaid
-- with Finicity behind it; nobody connects to seven thousand banks directly.
-- Which aggregator this product uses is a commercial decision that will
-- change — and the CFPB's 1033 rewrite has reopened whether banks may CHARGE
-- for data access, so it may change for reasons outside anyone's control.
--
-- So the ledger never learns the provider's name. One connection row per
-- institution login ("enrollment" at Teller, "Item" at Plaid — and note that
-- BOTH bill per login, not per account, which is why a shop with a Chase
-- checking account and a Chase card costs one unit, not two).
CREATE TABLE feed_connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('teller','plaid','manual')),
  /** The provider's own id for this institution login. */
  external_id   text NOT NULL,
  institution   text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','needs-reauth','revoked','error')),
  /**
   * ⛔ NEVER THE RAW ACCESS TOKEN. Encrypted at rest with the same KMS
   * envelope the QBO tokens use; the column holds ciphertext and the code
   * that reads it is the only thing that can decrypt.
   */
  access_token_enc bytea,
  last_synced_at   timestamptz,
  last_error       text NOT NULL DEFAULT '',
  created_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_id),
  UNIQUE (tenant_id, id)
);
ALTER TABLE feed_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_connections FORCE  ROW LEVEL SECURITY;
CREATE POLICY fc_tenant ON feed_connections
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
CREATE POLICY fc_department ON feed_connections
  AS RESTRICTIVE FOR ALL
  USING      (app.can_see_department('financials'))
  WITH CHECK (app.can_see_department('financials'));
GRANT SELECT, INSERT, UPDATE, DELETE ON feed_connections TO app_user;

-- Which connection an account came from, and the provider's id for it, so a
-- sync can find the row it is updating without guessing by name and last4.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS feed_connection_id uuid;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS external_account_id text;
ALTER TABLE bank_accounts
  ADD CONSTRAINT ba_feed_fk
  FOREIGN KEY (tenant_id, feed_connection_id) REFERENCES feed_connections(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ba_external_uk
  ON bank_accounts(tenant_id, feed_connection_id, external_account_id)
  WHERE external_account_id IS NOT NULL;

-- ── proof ────────────────────────────────────────────────────────────────
DO $$
DECLARE t uuid; n int;
BEGIN
  SELECT id INTO t FROM tenants LIMIT 1;
  IF t IS NULL THEN
    RAISE NOTICE 'no tenants yet — skipping the probe';
    RETURN;
  END IF;
  PERFORM set_config('app.current_tenant', t::text, true);
  PERFORM set_config('app.current_departments', 'financials', true);

  INSERT INTO feed_connections (tenant_id, provider, external_id, institution)
  VALUES (t, 'manual', '__probe__', 'probe');
  UPDATE feed_connections SET status = 'needs-reauth'
   WHERE tenant_id = t AND external_id = '__probe__';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'feed_connections UPDATE matched % rows, not 1', n;
  END IF;
  DELETE FROM feed_connections WHERE tenant_id = t AND external_id = '__probe__';
  RAISE NOTICE 'account kinds, transfers and feed connections are in place';
END $$;
