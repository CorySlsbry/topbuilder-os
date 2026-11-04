-- 0020: financial depth — payroll runs, tax remittances, advisor invites.
--
-- S18 payroll: a pay run clears accrued wages (DR 2400 / CR cash) for one
-- period, once (UNIQUE). Withholding/filings arrive with the embedded
-- provider (Check/Gusto — NEEDS-CORY); the accrual spine is ready.
-- S19 tax: remitting sales tax clears 2350 (DR 2350 / CR cash), once per
-- period label. S21: advisor invites let a CPA join as 'bookkeeper' via a
-- one-time code — redemption is SECURITY DEFINER (no membership exists yet).

CREATE TABLE payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  wages_cents bigint NOT NULL CHECK (wages_cents > 0),
  journal_entry_id uuid,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start, period_end)
);

CREATE TABLE tax_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  period_label text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  remitted_on date NOT NULL,
  journal_entry_id uuid,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_label)
);

CREATE TABLE advisor_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  role text NOT NULL DEFAULT 'bookkeeper' CHECK (role IN ('bookkeeper', 'viewer')),
  revoked boolean NOT NULL DEFAULT false,
  redeemed_by text,
  redeemed_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_runs', 'tax_remittances', 'advisor_invites'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON payroll_runs, tax_remittances TO app_user;
GRANT SELECT, INSERT, UPDATE ON advisor_invites TO app_user;

-- Money records: append-only at both layers.
CREATE TRIGGER payroll_runs_immutable
  BEFORE UPDATE OR DELETE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();
CREATE TRIGGER tax_remittances_immutable
  BEFORE UPDATE OR DELETE ON tax_remittances
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();

-- Redeem an advisor invite: the CPA has a code but NO membership yet, so
-- this runs SECURITY DEFINER — validates the code, creates the membership
-- (idempotent), marks the invite redeemed. Returns the tenant joined.
CREATE OR REPLACE FUNCTION app.redeem_advisor_invite(p_code uuid, p_uid text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE v_tenant uuid; v_role text;
BEGIN
  SELECT tenant_id, role INTO v_tenant, v_role
    FROM advisor_invites
   WHERE code = p_code AND NOT revoked AND redeemed_by IS NULL
   FOR UPDATE;
  IF v_tenant IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO memberships (tenant_id, user_id, role)
  VALUES (v_tenant, p_uid, v_role)
  ON CONFLICT (tenant_id, user_id) DO NOTHING;
  UPDATE advisor_invites SET redeemed_by = p_uid, redeemed_at = now()
   WHERE code = p_code;
  RETURN v_tenant;
END $$;
REVOKE ALL ON FUNCTION app.redeem_advisor_invite(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.redeem_advisor_invite(uuid, text) TO app_user;
