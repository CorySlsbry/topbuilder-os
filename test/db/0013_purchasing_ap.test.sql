-- pgTAP tests for purchasing/AP (migration 0013).
BEGIN;
SELECT plan(6);

INSERT INTO tenants(id, name, slug) VALUES
  ('11111111-aaaa-1111-1111-111111111111', 'Ap A', 'ap-a'),
  ('11111111-bbbb-1111-1111-111111111111', 'Ap B', 'ap-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('11111111-aaaa-1111-1111-111111111111', 'user-apa', 'owner'),
  ('11111111-bbbb-1111-1111-111111111111', 'user-apb', 'owner');
INSERT INTO vendors(id, tenant_id, name, is_1099) VALUES
  ('11111111-aaaa-0000-0000-000000000001', '11111111-aaaa-1111-1111-111111111111', 'Acme Sub LLC', true);
INSERT INTO vendors(id, tenant_id, name) VALUES
  ('11111111-bbbb-0000-0000-000000000001', '11111111-bbbb-1111-1111-111111111111', 'B Vendor');
INSERT INTO bills(id, tenant_id, vendor_id, issued_on, total_cents, created_by) VALUES
  ('11111111-aaaa-0000-0000-000000000002', '11111111-aaaa-1111-1111-111111111111',
   '11111111-aaaa-0000-0000-000000000001', '2026-07-24', 125000, 'user-apa');
INSERT INTO bill_payments(tenant_id, bill_id, paid_on, amount_cents, created_by) VALUES
  ('11111111-aaaa-1111-1111-111111111111', '11111111-aaaa-0000-0000-000000000002',
   '2026-07-24', 50000, 'user-apa');

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-apa', true);
SELECT set_config('app.current_tenant', '11111111-aaaa-1111-1111-111111111111', true);
SELECT set_config('app.current_departments', 'financials', true);

-- 1) bill payments are append-only at the grant layer
SELECT throws_ok($$ UPDATE bill_payments SET amount_cents = 1 $$, '42501', NULL,
  'bill_payments UPDATE denied at grant layer');

-- 2) a bill cannot reference another tenant's vendor (composite FK)
SELECT throws_ok($$
  INSERT INTO bills(tenant_id, vendor_id, issued_on, total_cents, created_by)
  VALUES ('11111111-aaaa-1111-1111-111111111111', '11111111-bbbb-0000-0000-000000000001',
          '2026-07-24', 100, 'user-apa')
$$, '23503', NULL, 'cross-tenant vendor reference is an FK violation');

-- 3) a bill line must be a job line OR an account line, never both/neither
SELECT throws_ok($$
  INSERT INTO bill_lines(tenant_id, bill_id, line_no, amount_cents)
  VALUES ('11111111-aaaa-1111-1111-111111111111', '11111111-aaaa-0000-0000-000000000002', 1, 100)
$$, '23514', NULL, 'a line with neither job nor account violates the CHECK');

-- 4) RLS: tenant B sees none of A's AP
SELECT set_config('app.current_uid', 'user-apb', true);
SELECT set_config('app.current_tenant', '11111111-bbbb-1111-1111-111111111111', true);
SELECT is((SELECT count(*) FROM bills)::int, 0, 'tenant B sees 0 bills of A');
SELECT is((SELECT count(*) FROM bill_payments)::int, 0, 'tenant B sees 0 bill payments of A');

-- 5) payment immutability holds even as superuser
RESET ROLE;
SELECT throws_ok($$ DELETE FROM bill_payments $$, 'P0001', NULL,
  'bill_payments immutable even as superuser');

SELECT * FROM finish();
ROLLBACK;
