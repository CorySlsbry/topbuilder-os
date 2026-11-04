-- pgTAP tests for workforce (migration 0014).
BEGIN;
SELECT plan(7);

INSERT INTO tenants(id, name, slug) VALUES
  ('22222222-aaaa-2222-2222-222222222222', 'Wf A', 'wf-a'),
  ('22222222-bbbb-2222-2222-222222222222', 'Wf B', 'wf-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('22222222-aaaa-2222-2222-222222222222', 'user-wfa', 'owner'),
  ('22222222-bbbb-2222-2222-222222222222', 'user-wfb', 'owner');
INSERT INTO wc_classes(tenant_id, class_code, rate_per100_cents) VALUES
  ('22222222-aaaa-2222-2222-222222222222', '5551', 1850);
INSERT INTO workers(id, tenant_id, name, wc_class_code, base_hourly_cents) VALUES
  ('22222222-aaaa-0000-0000-000000000001', '22222222-aaaa-2222-2222-222222222222', 'Miguel', '5551', 2800);
INSERT INTO customers(id, tenant_id, name) VALUES
  ('22222222-aaaa-0000-0000-000000000002', '22222222-aaaa-2222-2222-222222222222', 'Cust');
INSERT INTO properties(id, tenant_id, customer_id, address) VALUES
  ('22222222-aaaa-0000-0000-000000000003', '22222222-aaaa-2222-2222-222222222222',
   '22222222-aaaa-0000-0000-000000000002', '1 Main St');
INSERT INTO jobs(id, tenant_id, customer_id, property_id, job_no, name) VALUES
  ('22222222-aaaa-0000-0000-000000000004', '22222222-aaaa-2222-2222-222222222222',
   '22222222-aaaa-0000-0000-000000000002', '22222222-aaaa-0000-0000-000000000003', 901, 'Wf job');
INSERT INTO time_entries(id, tenant_id, job_id, worker_id, work_date, hours_x100, ot_x100, user_id, status) VALUES
  ('22222222-aaaa-0000-0000-000000000005', '22222222-aaaa-2222-2222-222222222222',
   '22222222-aaaa-0000-0000-000000000004', '22222222-aaaa-0000-0000-000000000001',
   '2026-07-20', 800, 0, 'user-wfa', 'posted');

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-wfa', true);
SELECT set_config('app.current_tenant', '22222222-aaaa-2222-2222-222222222222', true);
SELECT set_config('app.current_departments', 'financials', true);

-- 1) duplicate WC class per tenant is rejected
SELECT throws_ok($$
  INSERT INTO wc_classes(tenant_id, class_code, rate_per100_cents)
  VALUES ('22222222-aaaa-2222-2222-222222222222', '5551', 999)
$$, '23505', NULL, 'duplicate WC class code rejected');

-- 2) a POSTED time entry is locked (trigger, even for its own tenant)
SELECT throws_ok($$
  UPDATE time_entries SET hours_x100 = 900
   WHERE id = '22222222-aaaa-0000-0000-000000000005'
$$, 'P0001', NULL, 'posted time entry cannot be edited');
-- DELETE is denied at the grant layer for app_user (no DELETE grant at all);
-- the trigger's P0001 backstop is proven as superuser below.
SELECT throws_ok($$
  DELETE FROM time_entries WHERE id = '22222222-aaaa-0000-0000-000000000005'
$$, '42501', NULL, 'time entry DELETE denied at the grant layer');

-- 3) RLS: tenant B sees no workers/time of A
SELECT set_config('app.current_uid', 'user-wfb', true);
SELECT set_config('app.current_tenant', '22222222-bbbb-2222-2222-222222222222', true);
SELECT is((SELECT count(*) FROM workers)::int, 0, 'tenant B sees 0 workers of A');
SELECT is((SELECT count(*) FROM wc_classes)::int, 0, 'tenant B sees 0 wc classes of A');

-- 4) cross-tenant crew membership is impossible (composite FK)
INSERT INTO crews(id, tenant_id, name) VALUES
  ('22222222-bbbb-0000-0000-000000000001', '22222222-bbbb-2222-2222-222222222222', 'B crew');
SELECT throws_ok($$
  INSERT INTO crew_members(tenant_id, crew_id, worker_id)
  VALUES ('22222222-bbbb-2222-2222-222222222222', '22222222-bbbb-0000-0000-000000000001',
          '22222222-aaaa-0000-0000-000000000001')
$$, '23503', NULL, 'crew cannot contain another tenant''s worker');

-- 5) the posted-time trigger holds even as superuser (second layer)
RESET ROLE;
SELECT throws_ok($$
  DELETE FROM time_entries WHERE id = '22222222-aaaa-0000-0000-000000000005'
$$, 'P0001', NULL, 'posted time entry immutable even as superuser');

SELECT * FROM finish();
ROLLBACK;
