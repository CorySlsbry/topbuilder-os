-- S18b — Certified payroll (Davis-Bacon WH-347).
--
-- Gusto (and Gusto Embedded) does NOT do prevailing wage or produce WH-347;
-- that gap is why contractors on government work bolt on a second tool. We
-- already hold the pieces nobody else has in one place — hours by JOB, by
-- classification, split standard/overtime — so the report is ours to generate.
-- The payroll provider supplies the actual deductions; we supply the job truth.
--
-- Everything here is additive and nullable: a residential shop that never
-- touches a federal job sees none of it.

-- Worker identity as WH-347 requires it: a per-worker identifying number
-- (col 1E — "last four digits of the SSN or any number specific to the
-- worker") and an address, which is required on a worker's FIRST payroll.
-- We deliberately store an identifying NUMBER, never a full SSN: the form
-- explicitly permits a non-SSN identifier, so holding the real thing would be
-- taking on regulated PII for no benefit.
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS identifying_number text,
  ADD COLUMN IF NOT EXISTS address text;

COMMENT ON COLUMN workers.identifying_number IS
  'WH-347 col 1E. Last 4 of SSN OR any worker-specific number. NEVER a full SSN.';

-- Job-side facts the form needs, and the flag that turns the feature on.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS prevailing_wage boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS contract_number text,
  ADD COLUMN IF NOT EXISTS project_location text;

COMMENT ON COLUMN jobs.prevailing_wage IS
  'Davis-Bacon / prevailing-wage job: certified payroll is required weekly.';

-- One row per (job, week). The payroll NUMBER must be sequential and stable
-- per project — an auditor reads the sequence, so it cannot be recomputed from
-- a query that might renumber when a week is amended.
CREATE TABLE IF NOT EXISTS certified_payrolls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  week_ending date NOT NULL,
  payroll_number int NOT NULL,
  /* A "final" payroll closes the project. WH-347 asks for it explicitly. */
  is_final boolean NOT NULL DEFAULT false,
  /* Where the deductions came from. 'estimated' can NEVER be certified —
     the Statement of Compliance is a legal certification that the figures are
     accurate, and our bps-derived burden is a projection, not withholding. */
  deductions_source text NOT NULL DEFAULT 'estimated'
    CHECK (deductions_source IN ('estimated', 'payroll_run')),
  certified_by text,
  certified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  UNIQUE (tenant_id, job_id, week_ending),
  UNIQUE (tenant_id, job_id, payroll_number),
  /* The guard that matters: you cannot certify an estimate. */
  CONSTRAINT certified_needs_real_deductions
    CHECK (certified_at IS NULL OR deductions_source = 'payroll_run')
);

CREATE INDEX IF NOT EXISTS certified_payrolls_tenant_job_idx
  ON certified_payrolls (tenant_id, job_id, week_ending DESC);

ALTER TABLE certified_payrolls ENABLE ROW LEVEL SECURITY;
ALTER TABLE certified_payrolls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON certified_payrolls
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- A certification is a signed legal statement: it may be created and signed,
-- never deleted. Amendments are a NEW payroll number, the same way a ledger
-- correction is a reversing entry rather than an edit.
GRANT SELECT, INSERT, UPDATE ON certified_payrolls TO app_user;
