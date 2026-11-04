-- pgTAP tests for LIR cohort instrumentation (migration 0010).
BEGIN;
SELECT plan(3);

SELECT has_function('app', 'lir_cohorts', 'app.lir_cohorts() exists');

-- app_user can execute it (SECURITY DEFINER — returns anonymous aggregates
-- only; the API route adds the platform-operator allowlist on top).
SET ROLE app_user;
SELECT lives_ok('SELECT * FROM app.lir_cohorts()', 'app_user can call lir_cohorts');

-- The function returns only anonymous aggregate columns — no tenant ids.
RESET ROLE;
SELECT is(
  pg_get_function_result('app.lir_cohorts'::regproc),
  'TABLE(cohort_month text, tenants bigint, tenants_through_loop bigint, loop_jobs bigint)',
  'lir_cohorts exposes only aggregate columns'
);

SELECT * FROM finish();
ROLLBACK;
