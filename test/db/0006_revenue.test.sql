-- pgTAP tests for the revenue tables (migration 0006).
BEGIN;
SELECT plan(8);

-- fixtures (superuser)
INSERT INTO tenants(id, name, slug) VALUES
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Rev A', 'rev-a'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Rev B', 'rev-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'user-ra', 'owner'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'user-rb', 'owner');
INSERT INTO customers(id, tenant_id, name) VALUES
  ('eeeeeeee-0000-0000-0000-000000000001', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Cust A');
INSERT INTO jobs(id, tenant_id, customer_id, job_no, name) VALUES
  ('eeeeeeee-1111-0000-0000-000000000001', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
   'eeeeeeee-0000-0000-0000-000000000001', 1, 'Rev job');
INSERT INTO invoices(id, tenant_id, job_id, invoice_no, subtotal_cents, tax_cents,
                     retainage_cents, due_now_cents, issued_on) VALUES
  ('eeeeeeee-2222-0000-0000-000000000001', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
   'eeeeeeee-1111-0000-0000-000000000001', 1, 1000000, 60000, 106000, 954000, '2026-07-01');
INSERT INTO payments(tenant_id, invoice_id, amount_cents, received_on) VALUES
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eeeeeeee-2222-0000-0000-000000000001', 500000, '2026-07-05');

-- as app_user
SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-ra', true);
SELECT set_config('app.current_tenant', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', true);
SELECT set_config('app.current_departments', 'financials', true);

-- 1) payments append-only at the grant layer
SELECT throws_ok($$ UPDATE payments SET amount_cents = 1 $$, '42501', NULL,
  'payments UPDATE denied at the grant layer');
SELECT throws_ok($$ DELETE FROM payments $$, '42501', NULL,
  'payments DELETE denied at the grant layer');

-- 2) invoice_no unique per tenant
SELECT throws_ok($$
  INSERT INTO invoices(tenant_id, job_id, invoice_no, subtotal_cents, due_now_cents, issued_on)
  VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eeeeeeee-1111-0000-0000-000000000001',
          1, 100, 100, '2026-07-02')
$$, '23505', NULL, 'duplicate invoice_no rejected');

-- 3) retainage rate bounded by CHECK
SELECT throws_ok($$
  INSERT INTO invoices(tenant_id, job_id, invoice_no, subtotal_cents, due_now_cents,
                       retainage_bps, issued_on)
  VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eeeeeeee-1111-0000-0000-000000000001',
          9, 100, 100, 9000, '2026-07-02')
$$, '23514', NULL, 'retainage above 50% violates the CHECK');

-- 4) a payment cannot reference another tenant's invoice (composite FK)
SELECT set_config('app.current_uid', 'user-rb', true);
SELECT set_config('app.current_tenant', 'ffffffff-ffff-ffff-ffff-ffffffffffff', true);
SELECT throws_ok($$
  INSERT INTO payments(tenant_id, invoice_id, amount_cents, received_on)
  VALUES ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'eeeeeeee-2222-0000-0000-000000000001',
          100, '2026-07-05')
$$, '23503', NULL, 'cross-tenant invoice reference is an FK violation');

-- 5) RLS: tenant B sees none of A's revenue data
SELECT is((SELECT count(*) FROM invoices)::int, 0, 'tenant B sees 0 invoices of A');
SELECT is((SELECT count(*) FROM payments)::int, 0, 'tenant B sees 0 payments of A');

-- 6) trigger layer holds for payments even as superuser
RESET ROLE;
SELECT throws_ok($$ DELETE FROM payments $$, 'P0001', NULL,
  'payments immutable trigger holds even as superuser');

SELECT * FROM finish();
ROLLBACK;
