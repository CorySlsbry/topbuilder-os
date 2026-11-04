-- Who is allowed to see what a job made?
--
-- Job profit is the number this product exists to produce, and it is also the
-- one number a shop can be hurt by showing to the wrong person. So the answer
-- is a per-tenant decision, not ours.
--
-- ── Why this is a SETTING and not a department key ────────────────────────
-- Departments model the org chart: dispatch, financials, hr, field. A person
-- either does that job or doesn't. "May the crew see job profit?" is not a
-- role someone holds — it is one policy the OWNER sets once for the whole
-- shop. Modelling it as a department would mean clicking a grant onto thirty
-- people individually, and forgetting the thirty-first is a disclosure.
--
-- ── Why OFF by default, and why it can never be a default-on migration ────
-- On a two-person job, labor cost divided by hours IS that person's pay rate.
-- A crew member with a calculator learns what the other guy makes. That is a
-- payroll disclosure wearing a job-costing hat, and a shop must choose it
-- deliberately with a second factor, not inherit it because we shipped.
--
-- The route enforces the narrowing (`crewProfitView`), and the pure function
-- is tested for the ABSENCE of the forbidden keys. This table only records
-- the decision.

CREATE TABLE job_visibility_settings (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- OFF. See above. A default of true here would be a silent disclosure on
  -- every existing tenant the moment this migration ran.
  crew_sees_profit boolean NOT NULL DEFAULT false,
  updated_by       text NOT NULL DEFAULT '',
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- FORCE, unlike booking_settings. Nothing resolves tenancy FROM this table —
-- it is only ever read inside withTenant() with a session already established,
-- so the resolution-RLS exemption does not apply and the stricter setting is
-- the correct one. (0041's law is "a table used to RESOLVE tenancy must not be
-- FORCE"; it is not "settings tables are not FORCE".)
ALTER TABLE job_visibility_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_visibility_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_visibility_settings
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ⛔ SELECT, INSERT and UPDATE — all three, matched by the policy above.
-- Migration 0042 granted UPDATE on a column whose table had only a SELECT
-- policy: the write matched zero rows, returned 200, and the setting silently
-- never changed. A GRANT is permission to attempt, not permission to succeed.
GRANT SELECT, INSERT, UPDATE ON job_visibility_settings TO app_user;

-- Verify the policy actually admits a write, rather than trusting that it
-- reads correctly. Runs as `postgres`, which on this instance is NOT a
-- superuser and does NOT bypass FORCE RLS — so this exercises the real policy.
DO $$
DECLARE
  t uuid;
  n int;
BEGIN
  SELECT id INTO t FROM tenants ORDER BY created_at LIMIT 1;
  IF t IS NULL THEN
    RAISE NOTICE 'no tenants yet — skipping the write probe';
    RETURN;
  END IF;
  PERFORM set_config('app.current_tenant', t::text, true);

  INSERT INTO job_visibility_settings (tenant_id) VALUES (t)
    ON CONFLICT (tenant_id) DO NOTHING;
  UPDATE job_visibility_settings SET crew_sees_profit = true WHERE tenant_id = t;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'job_visibility_settings UPDATE matched % rows, not 1 — the policy does not admit writes', n;
  END IF;

  -- Leave it OFF. The probe must not be the thing that switches disclosure on.
  UPDATE job_visibility_settings SET crew_sees_profit = false WHERE tenant_id = t;
  RAISE NOTICE 'job_visibility_settings: policy admits SELECT/INSERT/UPDATE';
END $$;
