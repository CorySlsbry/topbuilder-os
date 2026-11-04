-- 0010: LIR cohort instrumentation.
--
-- The primary leading-indicator of retention:
--   70% of new shops run >= 3 jobs through the COMPLETE loop
--   (scheduled -> costs captured -> invoiced -> paid -> reconciled clean)
--   within 45 days of signup.
--
-- Cross-tenant by nature, so it is a SECURITY DEFINER function that returns
-- ONLY anonymous aggregates per signup-month cohort — never tenant rows.
-- The API route additionally gates on a platform-operator allowlist.

CREATE OR REPLACE FUNCTION app.lir_cohorts()
RETURNS TABLE (
  cohort_month text,
  tenants bigint,
  tenants_through_loop bigint,
  loop_jobs bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS $$
  WITH loop_jobs AS (
    SELECT j.tenant_id, j.id,
           t.created_at AS tenant_created
      FROM jobs j
      JOIN tenants t ON t.id = j.tenant_id
     WHERE EXISTS (SELECT 1 FROM appointments a
                    WHERE a.job_id = j.id
                      AND a.created_at <= t.created_at + interval '45 days')
       AND EXISTS (SELECT 1 FROM cost_entries ce
                    WHERE ce.job_id = j.id
                      AND ce.created_at <= t.created_at + interval '45 days')
       AND EXISTS (SELECT 1 FROM invoices i
                    JOIN payments p ON p.invoice_id = i.id
                    WHERE i.job_id = j.id
                      AND p.created_at <= t.created_at + interval '45 days')
       AND EXISTS (SELECT 1 FROM reconciliations r
                    WHERE r.tenant_id = j.tenant_id
                      AND r.created_at <= t.created_at + interval '45 days')
  ),
  per_tenant AS (
    SELECT t.id,
           to_char(t.created_at, 'YYYY-MM') AS cohort_month,
           COUNT(lj.id) AS loop_job_count
      FROM tenants t
      LEFT JOIN loop_jobs lj ON lj.tenant_id = t.id
     GROUP BY t.id, to_char(t.created_at, 'YYYY-MM')
  )
  SELECT cohort_month,
         COUNT(*) AS tenants,
         COUNT(*) FILTER (WHERE loop_job_count >= 3) AS tenants_through_loop,
         COALESCE(SUM(loop_job_count), 0) AS loop_jobs
    FROM per_tenant
   GROUP BY cohort_month
   ORDER BY cohort_month;
$$;

REVOKE ALL ON FUNCTION app.lir_cohorts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lir_cohorts() TO app_user;
