-- 0004_field_ops — the operational core: customers/properties/JOBS (the
-- central noun), scheduling, time, and the append-only job-cost ledger.
-- Plus the onboarding wiring (Cory 2026-07-23): tenant entity_type and the
-- state-agnostic tenant_tax_profiles (resolved from the CUSTOMER'S state at
-- signup — nothing state-specific in code).
-- Isolation: FORCE RLS everywhere; composite FKs pin children to the tenant.

-- ------------------------------------------------- onboarding wiring
ALTER TABLE tenants ADD COLUMN entity_type text NOT NULL DEFAULT 'sole-prop'
  CHECK (entity_type IN ('sole-prop','partnership','smllc','s-corp','c-corp'));

CREATE TABLE tenant_tax_profiles (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  state      text NOT NULL,             -- USPS code, e.g. 'TX'
  method     text NOT NULL DEFAULT 'retail'
             CHECK (method IN ('none','retail','gross-factor','materials-cost')),
  state_bps  int NOT NULL DEFAULT 0,
  county_bps int NOT NULL DEFAULT 0,
  city_bps   int NOT NULL DEFAULT 0,
  factor_bps int,
  source     text NOT NULL DEFAULT 'manual',  -- 'manual' | 'api:<provider>'
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_tax_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_tax_profiles FORCE  ROW LEVEL SECURITY;
CREATE POLICY ttp_tenant ON tenant_tax_profiles
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

-- Atomic per-tenant counters (job numbers etc.) — race-free via UPSERT.
CREATE TABLE tenant_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key       text NOT NULL,
  value     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, key)
);
ALTER TABLE tenant_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_counters FORCE  ROW LEVEL SECURITY;
CREATE POLICY tc_tenant ON tenant_counters
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

CREATE OR REPLACE FUNCTION app.next_counter(p_key text) RETURNS bigint
  LANGUAGE sql AS $$
  INSERT INTO tenant_counters (tenant_id, key, value)
       VALUES (app.current_tenant(), p_key, 1)
  ON CONFLICT (tenant_id, key) DO UPDATE SET value = tenant_counters.value + 1
  RETURNING value
$$;

-- ------------------------------------------------- customers / properties
CREATE TABLE customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  email      text,
  phone      text,
  address    text,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE  ROW LEVEL SECURITY;
CREATE POLICY cust_tenant ON customers
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

CREATE TABLE properties (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  address     text NOT NULL,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties FORCE  ROW LEVEL SECURITY;
CREATE POLICY prop_tenant ON properties
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

-- ------------------------------------------------- jobs (the central noun)
CREATE TABLE jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  property_id uuid,
  job_no      bigint NOT NULL,          -- per-tenant sequential (counters)
  name        text NOT NULL,
  job_type    text NOT NULL DEFAULT 'retail'
              CHECK (job_type IN ('retail','insurance-restoration','solar-financed')),
  status      text NOT NULL DEFAULT 'lead'
              CHECK (status IN ('lead','scheduled','in-progress','complete','closed')),
  contract_cents bigint NOT NULL DEFAULT 0 CHECK (contract_cents >= 0),
  budget_cents   bigint NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  est_cost_to_complete_cents bigint,     -- the owner's ETC input (WIP)
  etc_updated_at timestamptz,
  -- insurance-restoration fields
  claim_number   text,
  carrier        text,
  adjuster_name  text,
  adjuster_phone text,
  deductible_cents bigint CHECK (deductible_cents IS NULL OR deductible_cents >= 0),
  acv_cents        bigint CHECK (acv_cents IS NULL OR acv_cents >= 0),
  rcv_cents        bigint CHECK (rcv_cents IS NULL OR rcv_cents >= 0),
  depreciation_invoiced boolean NOT NULL DEFAULT false,
  -- solar-financed fields
  gross_contract_cents bigint CHECK (gross_contract_cents IS NULL OR gross_contract_cents >= 0),
  dealer_fee_cents     bigint CHECK (dealer_fee_cents IS NULL OR dealer_fee_cents >= 0),
  lender               text,
  completed_on date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, job_no),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties(tenant_id, id)
);
CREATE INDEX jobs_tenant_status_idx ON jobs(tenant_id, status);
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE  ROW LEVEL SECURITY;
CREATE POLICY jobs_tenant ON jobs
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

-- ------------------------------------------------- scheduling / time / codes
CREATE TABLE appointments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id       uuid NOT NULL,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  assignee_uid text,
  notes        text,
  status       text NOT NULL DEFAULT 'scheduled'
               CHECK (status IN ('scheduled','done','canceled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id)
);
CREATE INDEX appt_tenant_time_idx ON appointments(tenant_id, starts_at);
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE  ROW LEVEL SECURITY;
CREATE POLICY appt_tenant ON appointments
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

CREATE TABLE cost_codes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code      text NOT NULL,
  name      text NOT NULL,
  kind      text NOT NULL DEFAULT 'other'
            CHECK (kind IN ('labor','material','sub','equipment','other')),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);
ALTER TABLE cost_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_codes FORCE  ROW LEVEL SECURITY;
CREATE POLICY cc_tenant ON cost_codes
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

CREATE TABLE time_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id     uuid NOT NULL,
  user_id    text NOT NULL,
  work_date  date NOT NULL,
  hours_x100 int NOT NULL CHECK (hours_x100 > 0 AND hours_x100 <= 2400),
  ot_x100    int NOT NULL DEFAULT 0 CHECK (ot_x100 >= 0 AND ot_x100 <= 2400),
  cost_code  text,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id)
);
CREATE INDEX te_tenant_job_idx ON time_entries(tenant_id, job_id, work_date);
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries FORCE  ROW LEVEL SECURITY;
CREATE POLICY te_tenant ON time_entries
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

-- ------------------------------------------------- cost_entries (APPEND-ONLY)
-- The operational job-cost ledger: every cost hits a job + cost code here and
-- posts to the GL through the ledger port. Same two-layer append-only defense
-- as the journal (no UPDATE/DELETE grant + the purge-aware immutable trigger).
CREATE TABLE cost_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id       uuid NOT NULL,
  cost_code    text NOT NULL,
  kind         text NOT NULL DEFAULT 'material'
               CHECK (kind IN ('labor','material','sub','equipment','other')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  memo         text NOT NULL DEFAULT '',
  source_type  text NOT NULL DEFAULT 'manual'   -- receipt|time|bill|manual
               CHECK (source_type IN ('receipt','time','bill','manual')),
  journal_entry_id uuid,                        -- the GL posting it produced
  occurred_on  date NOT NULL,
  created_by   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id)
);
CREATE INDEX ce_tenant_job_idx ON cost_entries(tenant_id, job_id, occurred_on);
ALTER TABLE cost_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_entries FORCE  ROW LEVEL SECURITY;
CREATE POLICY ce_tenant ON cost_entries
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
CREATE TRIGGER cost_entries_immutable
  BEFORE UPDATE OR DELETE ON cost_entries
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();

-- ------------------------------------------------- the depreciation nudge
-- "If you do not invoice for the depreciation you do not get it."
-- Insurance jobs, completed, with RCV recorded but depreciation not invoiced.
CREATE VIEW pending_depreciation_nudges AS
  SELECT j.id AS job_id, j.tenant_id, j.job_no, j.name, j.claim_number,
         j.carrier, j.rcv_cents, j.acv_cents, j.completed_on
    FROM jobs j
   WHERE j.job_type = 'insurance-restoration'
     AND j.status IN ('complete','closed')
     AND NOT j.depreciation_invoiced
     AND COALESCE(j.rcv_cents, 0) > 0;

-- ------------------------------------------------- grants (app_user)
GRANT SELECT, INSERT, UPDATE ON tenant_tax_profiles TO app_user;
GRANT SELECT, INSERT, UPDATE ON tenant_counters TO app_user;
GRANT SELECT, INSERT, UPDATE ON customers, properties, jobs, appointments, cost_codes, time_entries TO app_user;
GRANT SELECT, INSERT         ON cost_entries TO app_user;  -- append-only
GRANT SELECT ON pending_depreciation_nudges TO app_user;
GRANT EXECUTE ON FUNCTION app.next_counter(text) TO app_user;
