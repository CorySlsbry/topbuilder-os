-- pgTAP tests for inventory (migration 0015).
BEGIN;
SELECT plan(6);

INSERT INTO tenants(id, name, slug) VALUES
  ('33333333-aaaa-3333-3333-333333333333', 'Inv A', 'inv-a'),
  ('33333333-bbbb-3333-3333-333333333333', 'Inv B', 'inv-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('33333333-aaaa-3333-3333-333333333333', 'user-inva', 'owner'),
  ('33333333-bbbb-3333-3333-333333333333', 'user-invb', 'owner');
INSERT INTO inventory_items(id, tenant_id, name, qty_on_hand_x100, avg_unit_cost_cents) VALUES
  ('33333333-aaaa-0000-0000-000000000001', '33333333-aaaa-3333-3333-333333333333',
   'Shingle bundle', 1000, 3200);
INSERT INTO inventory_moves(tenant_id, item_id, kind, qty_x100, unit_cost_cents,
                            memo, occurred_on, created_by) VALUES
  ('33333333-aaaa-3333-3333-333333333333', '33333333-aaaa-0000-0000-000000000001',
   'receipt', 1000, 3200, 'seed', '2026-07-24', 'user-inva');

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-inva', true);
SELECT set_config('app.current_tenant', '33333333-aaaa-3333-3333-333333333333', true);
SELECT set_config('app.current_departments', 'financials', true);

-- 1) negative stock is impossible at the database
SELECT throws_ok($$
  UPDATE inventory_items SET qty_on_hand_x100 = -100
   WHERE id = '33333333-aaaa-0000-0000-000000000001'
$$, '23514', NULL, 'negative stock violates the CHECK');

-- 2) the stock ledger is append-only at the grant layer
SELECT throws_ok($$ UPDATE inventory_moves SET qty_x100 = 1 $$, '42501', NULL,
  'inventory_moves UPDATE denied at the grant layer');

-- 3) duplicate item name per tenant is rejected
SELECT throws_ok($$
  INSERT INTO inventory_items(tenant_id, name)
  VALUES ('33333333-aaaa-3333-3333-333333333333', 'Shingle bundle')
$$, '23505', NULL, 'duplicate item name rejected');

-- 4) RLS: tenant B sees nothing of A
SELECT set_config('app.current_uid', 'user-invb', true);
SELECT set_config('app.current_tenant', '33333333-bbbb-3333-3333-333333333333', true);
SELECT is((SELECT count(*) FROM inventory_items)::int, 0, 'tenant B sees 0 items of A');
SELECT is((SELECT count(*) FROM inventory_moves)::int, 0, 'tenant B sees 0 moves of A');

-- 5) move immutability holds even as superuser
RESET ROLE;
SELECT throws_ok($$ DELETE FROM inventory_moves $$, 'P0001', NULL,
  'inventory_moves immutable even as superuser');

SELECT * FROM finish();
ROLLBACK;
