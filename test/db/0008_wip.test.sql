-- pgTAP tests for WIP snapshots + purchase orders (migration 0008).
BEGIN;
SELECT plan(8);

INSERT INTO tenants(id, name, slug) VALUES
  ('99999999-9999-9999-9999-999999999999', 'Wip A', 'wip-a'),
  ('88888888-8888-8888-8888-888888888888', 'Wip B', 'wip-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('99999999-9999-9999-9999-999999999999', 'user-wa', 'owner'),
  ('88888888-8888-8888-8888-888888888888', 'user-wb', 'owner');
INSERT INTO customers(id, tenant_id, name) VALUES
  ('99999999-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999999', 'C');
INSERT INTO jobs(id, tenant_id, customer_id, job_no, name) VALUES
  ('99999999-1111-0000-0000-000000000001', '99999999-9999-9999-9999-999999999999',
   '99999999-0000-0000-0000-000000000001', 1, 'Wip job');
INSERT INTO wip_snapshots(tenant_id, job_id, as_of, contract_cents, costs_to_date_cents,
  etc_cents, pct_complete_bps, earned_cents, billed_cents, underbilled_cents, overbilled_cents)
VALUES ('99999999-9999-9999-9999-999999999999', '99999999-1111-0000-0000-000000000001',
  '2026-07-01', 10000000, 4000000, 4000000, 5000, 5000000, 4000000, 1000000, 0);

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-wa', true);
SELECT set_config('app.current_tenant', '99999999-9999-9999-9999-999999999999', true);
SELECT set_config('app.current_departments', 'financials', true);

-- 1) snapshots append-only at the grant layer
SELECT throws_ok($$ UPDATE wip_snapshots SET earned_cents = 1 $$, '42501', NULL,
  'wip_snapshots UPDATE denied at the grant layer');
SELECT throws_ok($$ DELETE FROM wip_snapshots $$, '42501', NULL,
  'wip_snapshots DELETE denied at the grant layer');

-- 2) one snapshot per job per as-of date
SELECT throws_ok($$
  INSERT INTO wip_snapshots(tenant_id, job_id, as_of, contract_cents, costs_to_date_cents,
    etc_cents, pct_complete_bps, earned_cents, billed_cents, underbilled_cents, overbilled_cents)
  VALUES ('99999999-9999-9999-9999-999999999999', '99999999-1111-0000-0000-000000000001',
    '2026-07-01', 1, 1, 1, 0, 0, 0, 0, 0)
$$, '23505', NULL, 'duplicate (job, as_of) snapshot rejected');

-- 3) writing a row into a FOREIGN tenant is blocked by RLS WITH CHECK
--    (layer 1 — fires before the FK can even be evaluated)
SELECT throws_ok($$
  INSERT INTO purchase_orders(tenant_id, job_id, vendor_name, amount_cents)
  VALUES ('88888888-8888-8888-8888-888888888888', '99999999-1111-0000-0000-000000000001',
          'SRS', 100)
$$, '42501', NULL, 'foreign-tenant PO insert blocked by RLS WITH CHECK');

-- 4) RLS: tenant B sees none of A's WIP data
SELECT set_config('app.current_uid', 'user-wb', true);
SELECT set_config('app.current_tenant', '88888888-8888-8888-8888-888888888888', true);

-- 4b) layer 2 — with a VALID own-tenant row, referencing another tenant's job
--     is a composite-FK violation
SELECT throws_ok($$
  INSERT INTO purchase_orders(tenant_id, job_id, vendor_name, amount_cents)
  VALUES ('88888888-8888-8888-8888-888888888888', '99999999-1111-0000-0000-000000000001',
          'SRS', 100)
$$, '23503', NULL, 'cross-tenant PO job reference is an FK violation');
SELECT is((SELECT count(*) FROM wip_snapshots)::int, 0, 'tenant B sees 0 snapshots of A');
SELECT is((SELECT count(*) FROM purchase_orders)::int, 0, 'tenant B sees 0 POs of A');

-- 5) trigger layer holds even as superuser
RESET ROLE;
SELECT throws_ok($$ DELETE FROM wip_snapshots $$, 'P0001', NULL,
  'wip_snapshots immutable trigger holds even as superuser');

SELECT * FROM finish();
ROLLBACK;
