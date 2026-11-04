-- pgTAP tests for the field-ops core (migration 0004).
BEGIN;
SELECT plan(12);

-- fixtures (superuser)
INSERT INTO tenants(id, name, slug) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Ops A', 'ops-a'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Ops B', 'ops-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'user-oa', 'owner'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'user-ob', 'owner');
INSERT INTO customers(id, tenant_id, name) VALUES
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Smith'),
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'Jones');
INSERT INTO jobs(id, tenant_id, customer_id, job_no, name, job_type, status,
                 rcv_cents, acv_cents, completed_on) VALUES
  ('cccccccc-1111-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'cccccccc-0000-0000-0000-000000000001', 1, 'Smith re-roof',
   'insurance-restoration', 'complete', 2000000, 1500000, '2026-07-01');

-- as app_user, tenant A
SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-oa', true);
SELECT set_config('app.current_tenant', 'cccccccc-cccc-cccc-cccc-cccccccccccc', true);
SELECT set_config('app.current_departments', 'field-ops', true);

-- 1) counters are atomic + per-tenant
SELECT is(app.next_counter('job_no')::int, 1, 'counter starts at 1');
SELECT is(app.next_counter('job_no')::int, 2, 'counter increments');

-- 2) cross-tenant customer reference is an FK violation
SELECT throws_ok($$
  INSERT INTO jobs(tenant_id, customer_id, job_no, name)
  VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc',
          'dddddddd-0000-0000-0000-000000000001', 99, 'x')
$$, '23503', NULL, 'a job cannot reference another tenant''s customer');

-- 3) job_no is unique per tenant
SELECT throws_ok($$
  INSERT INTO jobs(tenant_id, customer_id, job_no, name)
  VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc',
          'cccccccc-0000-0000-0000-000000000001', 1, 'dup')
$$, '23505', NULL, 'duplicate job_no in a tenant is rejected');

-- 4) bad job_type rejected
SELECT throws_ok($$
  INSERT INTO jobs(tenant_id, customer_id, job_no, name, job_type)
  VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc',
          'cccccccc-0000-0000-0000-000000000001', 98, 'x', 'flipping')
$$, '23514', NULL, 'unknown job_type violates the CHECK');

-- 5) the depreciation nudge fires for the completed insurance job.
-- Scope to THIS tenant's rows explicitly: the dev DB may hold other tenants'
-- data, and the view must show ONLY ours (security_invoker → RLS applies).
SELECT is((SELECT count(*) FROM pending_depreciation_nudges
            WHERE tenant_id <> 'cccccccc-cccc-cccc-cccc-cccccccccccc')::int, 0,
  'nudge view leaks ZERO foreign-tenant rows (security_invoker RLS)');
SELECT is((SELECT count(*) FROM pending_depreciation_nudges
            WHERE tenant_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc')::int, 1,
  'completed insurance job with uninvoiced depreciation nudges');
-- and clears once depreciation is invoiced
UPDATE jobs SET depreciation_invoiced = true
 WHERE id = 'cccccccc-1111-0000-0000-000000000001';
SELECT is((SELECT count(*) FROM pending_depreciation_nudges
            WHERE tenant_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc')::int, 0,
  'nudge clears when depreciation is invoiced');

-- 6) cost_entries: append-only at the grant layer
INSERT INTO cost_entries(tenant_id, job_id, cost_code, amount_cents, occurred_on)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc',
        'cccccccc-1111-0000-0000-000000000001', '4100', 84200, '2026-07-01');
SELECT throws_ok($$
  UPDATE cost_entries SET amount_cents = 1
$$, '42501', NULL, 'cost_entries UPDATE denied at the grant layer');

-- 7) RLS: tenant B sees none of tenant A's ops data
SELECT set_config('app.current_uid', 'user-ob', true);
SELECT set_config('app.current_tenant', 'dddddddd-dddd-dddd-dddd-dddddddddddd', true);
SELECT is((SELECT count(*) FROM jobs)::int, 0, 'tenant B sees 0 jobs of A');
SELECT is((SELECT count(*) FROM cost_entries)::int, 0, 'tenant B sees 0 cost entries of A');

-- 8) trigger layer holds even for privileged roles
RESET ROLE;
SELECT throws_ok($$
  DELETE FROM cost_entries
$$, 'P0001', NULL, 'cost_entries immutable trigger holds even as superuser');

SELECT * FROM finish();
ROLLBACK;
