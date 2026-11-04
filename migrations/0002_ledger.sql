-- 0002_ledger — the double-entry general ledger: the book of record.
--
-- Invariants enforced AT THE DATABASE (not just in code):
--   1. Every journal entry balances: Σdebits = Σcredits (deferred constraint
--      trigger — an unbalanced entry cannot COMMIT).
--   2. Posted entries/lines are IMMUTABLE: no UPDATE, no DELETE, ever —
--      corrections are reversing entries. Enforced by trigger AND by grants.
--   3. Each line is exactly one-sided (debit XOR credit, both >= 0).
--   4. No posting into a CLOSED fiscal period.
--   5. Three-level isolation: FORCE RLS (tenant) on every table; composite
--      FKs pin children to the SAME tenant as their parents.
-- All money is integer cents (bigint).

-- ===================================================== chart_of_accounts
CREATE TABLE chart_of_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,          -- NAHB-style, e.g. '1265', '2480'
  name        text NOT NULL,
  type        text NOT NULL CHECK
              (type IN ('asset','liability','equity','revenue','cogs','expense','other')),
  section     text,                   -- NAHB section label (grouping only)
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)              -- composite-FK target
);
ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE chart_of_accounts FORCE  ROW LEVEL SECURITY;
CREATE POLICY coa_tenant_isolation ON chart_of_accounts
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- ===================================================== fiscal_periods
CREATE TABLE fiscal_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start date NOT NULL CHECK (period_start = date_trunc('month', period_start)::date),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at    timestamptz,
  closed_by    text,
  UNIQUE (tenant_id, period_start)
);
ALTER TABLE fiscal_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_periods FORCE  ROW LEVEL SECURITY;
CREATE POLICY fp_tenant_isolation ON fiscal_periods
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- ===================================================== journal (append-only)
CREATE TABLE journal_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  occurred_on date NOT NULL,
  memo        text NOT NULL DEFAULT '',
  source_type text NOT NULL DEFAULT 'manual',  -- invoice|payment|bill|manual|…
  source_id   uuid,
  reversal_of uuid,
  created_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, reversal_of) REFERENCES journal_entries(tenant_id, id)
);
CREATE INDEX journal_entries_tenant_date_idx ON journal_entries(tenant_id, occurred_on);
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE  ROW LEVEL SECURITY;
CREATE POLICY je_tenant_isolation ON journal_entries
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

CREATE TABLE journal_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id     uuid NOT NULL,
  account_id   uuid NOT NULL,
  line_no      int  NOT NULL DEFAULT 0,
  debit_cents  bigint NOT NULL DEFAULT 0 CHECK (debit_cents  >= 0),
  credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  -- exactly one side is nonzero
  CHECK ((debit_cents = 0) <> (credit_cents = 0)),
  -- job-costing dimensions (FKs land when those tables exist)
  job_id       uuid,
  cost_code    text,
  class        text,
  customer_id  uuid,
  vendor_id    uuid,
  -- children are pinned to the SAME tenant as their parents
  FOREIGN KEY (tenant_id, entry_id)   REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES chart_of_accounts(tenant_id, id)
);
CREATE INDEX journal_lines_entry_idx          ON journal_lines(entry_id);
CREATE INDEX journal_lines_tenant_account_idx ON journal_lines(tenant_id, account_id);
CREATE INDEX journal_lines_tenant_job_idx     ON journal_lines(tenant_id, job_id)
  WHERE job_id IS NOT NULL;
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE  ROW LEVEL SECURITY;
CREATE POLICY jl_tenant_isolation ON journal_lines
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- ============================================ invariant 1: balanced entries
-- Deferred constraint trigger: fires at COMMIT (or SET CONSTRAINTS IMMEDIATE),
-- so multi-line entries are inserted freely within the transaction and the
-- books can never end a transaction unbalanced. Runs with invoker rights —
-- RLS still applies to the SELECT.
CREATE OR REPLACE FUNCTION app.assert_entry_balanced() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint; n int;
BEGIN
  SELECT COALESCE(SUM(debit_cents), 0), COALESCE(SUM(credit_cents), 0), COUNT(*)
    INTO d, c, n
    FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal entry % must have at least 2 lines', NEW.entry_id;
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %',
      NEW.entry_id, d, c;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_entry_balanced();

-- ============================================ invariant 2: immutability
CREATE OR REPLACE FUNCTION app.forbid_ledger_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are immutable — post a reversing entry instead';
END $$;

CREATE TRIGGER journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();
CREATE TRIGGER journal_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();

-- ============================================ invariant 4: closed periods
CREATE OR REPLACE FUNCTION app.assert_period_open() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM fiscal_periods fp
     WHERE fp.tenant_id = NEW.tenant_id
       AND fp.period_start = date_trunc('month', NEW.occurred_on)::date
       AND fp.status = 'closed'
  ) THEN
    RAISE EXCEPTION 'fiscal period % is closed',
      date_trunc('month', NEW.occurred_on)::date;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entries_period_open
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.assert_period_open();

-- ===================================================== grants (app_user)
-- The journal is append-only AT THE GRANT LEVEL too: no UPDATE/DELETE exists
-- for the app role even if a trigger were dropped by mistake (defense in depth).
GRANT SELECT, INSERT, UPDATE ON chart_of_accounts TO app_user; -- no DELETE: deactivate
GRANT SELECT, INSERT, UPDATE ON fiscal_periods    TO app_user; -- open/close
GRANT SELECT, INSERT         ON journal_entries   TO app_user;
GRANT SELECT, INSERT         ON journal_lines     TO app_user;
