-- pgTAP tests for dispatch (migration 0016).
BEGIN;
SELECT plan(3);

INSERT INTO tenants(id, name, slug) VALUES
  ('44444444-aaaa-4444-4444-444444444444', 'Dp A', 'dp-a'),
  ('44444444-bbbb-4444-4444-444444444444', 'Dp B', 'dp-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('44444444-aaaa-4444-4444-444444444444', 'user-dpa', 'owner'),
  ('44444444-bbbb-4444-4444-444444444444', 'user-dpb', 'owner');
INSERT INTO wc_classes(tenant_id, class_code, rate_per100_cents) VALUES
  ('44444444-bbbb-4444-4444-444444444444', '5551', 1850);
INSERT INTO workers(id, tenant_id, name, wc_class_code, base_hourly_cents) VALUES
  ('44444444-bbbb-0000-0000-000000000001', '44444444-bbbb-4444-4444-444444444444', 'B worker', '5551', 2500);
INSERT INTO customers(id, tenant_id, name) VALUES
  ('44444444-aaaa-0000-0000-000000000002', '44444444-aaaa-4444-4444-444444444444', 'Cust');
INSERT INTO properties(id, tenant_id, customer_id, address) VALUES
  ('44444444-aaaa-0000-0000-000000000003', '44444444-aaaa-4444-4444-444444444444',
   '44444444-aaaa-0000-0000-000000000002', '2 Main St');
INSERT INTO jobs(id, tenant_id, customer_id, property_id, job_no, name) VALUES
  ('44444444-aaaa-0000-0000-000000000004', '44444444-aaaa-4444-4444-444444444444',
   '44444444-aaaa-0000-0000-000000000002', '44444444-aaaa-0000-0000-000000000003', 902, 'Dp job');
INSERT INTO appointments(id, tenant_id, job_id, starts_at, ends_at) VALUES
  ('44444444-aaaa-0000-0000-000000000005', '44444444-aaaa-4444-4444-444444444444',
   '44444444-aaaa-0000-0000-000000000004', '2026-07-27 08:00+00', '2026-07-27 12:00+00');

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-dpa', true);
SELECT set_config('app.current_tenant', '44444444-aaaa-4444-4444-444444444444', true);
SELECT set_config('app.current_departments', 'field-ops', true);

-- 1) an appointment cannot be assigned to another tenant's worker
SELECT throws_ok($$
  UPDATE appointments SET worker_id = '44444444-bbbb-0000-0000-000000000001'
   WHERE id = '44444444-aaaa-0000-0000-000000000005'
$$, '23503', NULL, 'cross-tenant worker assignment is an FK violation');

-- 2) same-tenant assignment works (control)
INSERT INTO wc_classes(tenant_id, class_code, rate_per100_cents) VALUES
  ('44444444-aaaa-4444-4444-444444444444', '5551', 1850);
INSERT INTO workers(id, tenant_id, name, wc_class_code, base_hourly_cents) VALUES
  ('44444444-aaaa-0000-0000-000000000006', '44444444-aaaa-4444-4444-444444444444', 'A worker', '5551', 2500);
UPDATE appointments SET worker_id = '44444444-aaaa-0000-0000-000000000006'
 WHERE id = '44444444-aaaa-0000-0000-000000000005';
SELECT is(
  (SELECT worker_id FROM appointments WHERE id = '44444444-aaaa-0000-0000-000000000005'),
  '44444444-aaaa-0000-0000-000000000006'::uuid,
  'same-tenant assignment sticks');

-- 3) RLS: tenant B sees none of A's appointments
SELECT set_config('app.current_uid', 'user-dpb', true);
SELECT set_config('app.current_tenant', '44444444-bbbb-4444-4444-444444444444', true);
SELECT is((SELECT count(*) FROM appointments)::int, 0, 'tenant B sees 0 appointments of A');

SELECT * FROM finish();
ROLLBACK;
