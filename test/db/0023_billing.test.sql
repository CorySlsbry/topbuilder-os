-- pgTAP: billing isolation + the purge hatch (migration 0023).
-- The bar: one customer can NEVER see or touch another customer's billing,
-- and "delete my account" can only ever delete the caller's own tenant.
BEGIN;
SELECT plan(9);

INSERT INTO tenants(id, name, slug) VALUES
  ('99999999-aaaa-9999-9999-999999999999', 'Bill A', 'bill-a'),
  ('99999999-bbbb-9999-9999-999999999999', 'Bill B', 'bill-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('99999999-aaaa-9999-9999-999999999999', 'user-bila', 'owner'),
  ('99999999-bbbb-9999-9999-999999999999', 'user-bilb', 'owner');
INSERT INTO subscriptions(tenant_id, plan, seat_cap, status, stripe_customer_id) VALUES
  ('99999999-aaaa-9999-9999-999999999999', 'crew', 10, 'active', 'cus_A_secret'),
  ('99999999-bbbb-9999-9999-999999999999', 'shop', 25, 'active', 'cus_B_secret');
-- A owns a customer row; used to prove the purge really removes data.
INSERT INTO customers(id, tenant_id, name) VALUES
  ('99999999-aaaa-0000-0000-000000000001', '99999999-aaaa-9999-9999-999999999999', 'A Customer');

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-bila', true);
SELECT set_config('app.current_tenant', '99999999-aaaa-9999-9999-999999999999', true);
SELECT set_config('app.current_departments', 'financials', true);

-- 1) A sees exactly its own subscription, never B's
SELECT is((SELECT count(*) FROM subscriptions)::int, 1, 'tenant A sees exactly 1 subscription');
SELECT is((SELECT plan FROM subscriptions), 'crew', 'and it is A''s own plan');

-- 2) A cannot write a row for B (WITH CHECK)
SELECT throws_ok($$
  INSERT INTO subscriptions(tenant_id, plan, seat_cap, status)
  VALUES ('99999999-bbbb-9999-9999-999999999999', 'shop', 25, 'active')
$$, '42501', NULL, 'tenant A cannot create a subscription for tenant B');

-- 3) A cannot hijack B's Stripe customer id (unique + RLS both hold)
SELECT throws_ok($$
  UPDATE subscriptions SET stripe_customer_id = 'cus_B_secret'
$$, '23505', NULL, 'A cannot claim B''s stripe customer id');

-- 4) B sees none of A's billing
SELECT set_config('app.current_uid', 'user-bilb', true);
SELECT set_config('app.current_tenant', '99999999-bbbb-9999-9999-999999999999', true);
SELECT is((SELECT count(*) FROM subscriptions WHERE stripe_customer_id = 'cus_A_secret')::int,
          0, 'tenant B cannot see A''s stripe customer id');

-- 5) THE BIG ONE: the purge deletes only the CALLER's tenant. B purges
--    itself while scoped as B; A must survive untouched.
SELECT lives_ok($$ SELECT app.purge_current_tenant() $$, 'B can purge its own tenant');
SELECT is((SELECT count(*) FROM tenants WHERE id = '99999999-bbbb-9999-9999-999999999999')::int,
          0, 'B is gone after its own purge');
RESET ROLE;
SELECT is((SELECT count(*) FROM customers WHERE id = '99999999-aaaa-0000-0000-000000000001')::int,
          1, 'A''s data SURVIVED B''s purge — the purge is caller-scoped only');

-- 6) An unscoped session cannot purge anything at all
SET ROLE app_user;
SELECT set_config('app.current_tenant', '', true);
SELECT throws_ok($$ SELECT app.purge_current_tenant() $$, NULL, NULL,
  'purge refuses to run with no tenant in scope');

SELECT * FROM finish();
ROLLBACK;
