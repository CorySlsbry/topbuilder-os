-- 0013: purchasing/AP — vendors, bills, vendor payments, 1099 tracking.
--
-- A bill posts DR job-cost (1430, with job dims) or expense / CR 2110 AP in
-- the same transaction it is created. Paying a bill posts DR 2110 / CR cash.
-- bill_payments are append-only money records (both layers, like payments).

CREATE TABLE vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  email text,
  phone text,
  -- 1099 tracking: eligibility flag + last4 of the TIN (never the full TIN).
  is_1099 boolean NOT NULL DEFAULT false,
  tax_id_last4 text CHECK (tax_id_last4 IS NULL OR tax_id_last4 ~ '^[0-9]{4}$'),
  default_account_code text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);

CREATE TABLE bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  vendor_id uuid NOT NULL,
  po_id uuid,
  bill_ref text NOT NULL DEFAULT '',
  issued_on date NOT NULL,
  due_on date,
  memo text NOT NULL DEFAULT '',
  total_cents bigint NOT NULL CHECK (total_cents > 0),
  paid_cents bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'paid', 'void')),
  journal_entry_id uuid,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES vendors (tenant_id, id),
  -- One bill per PO: the received-PO -> bill flow is idempotent.
  UNIQUE (tenant_id, po_id)
);

CREATE TABLE bill_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  bill_id uuid NOT NULL,
  line_no int NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  -- Either a job-cost line (job dims) or an expense line (account code).
  job_id uuid,
  cost_code text,
  cost_kind text CHECK (cost_kind IN ('labor', 'material', 'sub', 'equipment', 'other')),
  account_code text,
  description text NOT NULL DEFAULT '',
  CHECK (
    (job_id IS NOT NULL AND cost_code IS NOT NULL AND account_code IS NULL)
    OR (job_id IS NULL AND cost_code IS NULL AND account_code IS NOT NULL)
  ),
  UNIQUE (tenant_id, bill_id, line_no),
  FOREIGN KEY (tenant_id, bill_id) REFERENCES bills (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id)
);

CREATE TABLE bill_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  bill_id uuid NOT NULL,
  paid_on date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method text NOT NULL DEFAULT 'check',
  reference text,
  journal_entry_id uuid,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, bill_id) REFERENCES bills (tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendors', 'bills', 'bill_lines', 'bill_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON vendors, bills TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON bill_lines TO app_user;
-- Money movement record: append-only at BOTH layers.
GRANT SELECT, INSERT ON bill_payments TO app_user;
CREATE TRIGGER bill_payments_immutable
  BEFORE UPDATE OR DELETE ON bill_payments
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();
