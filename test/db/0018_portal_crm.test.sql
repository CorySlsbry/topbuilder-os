-- pgTAP tests for portal + CRM (migration 0018).
BEGIN;
SELECT plan(5);

INSERT INTO tenants(id, name, slug) VALUES
  ('66666666-cccc-6666-6666-666666666666', 'Pt A', 'pt-a'),
  ('66666666-dddd-6666-6666-666666666666', 'Pt B', 'pt-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('66666666-cccc-6666-6666-666666666666', 'user-pta', 'owner'),
  ('66666666-dddd-6666-6666-666666666666', 'user-ptb', 'owner');
INSERT INTO customers(id, tenant_id, name) VALUES
  ('66666666-cccc-0000-0000-000000000001', '66666666-cccc-6666-6666-666666666666', 'Portal Cust'),
  ('66666666-dddd-0000-0000-000000000001', '66666666-dddd-6666-6666-666666666666', 'B Cust');
INSERT INTO portal_tokens(tenant_id, customer_id, token, created_by) VALUES
  ('66666666-cccc-6666-6666-666666666666', '66666666-cccc-0000-0000-000000000001',
   '66666666-eeee-0000-0000-000000000001', 'user-pta');
INSERT INTO portal_tokens(tenant_id, customer_id, token, revoked, created_by) VALUES
  ('66666666-cccc-6666-6666-666666666666', '66666666-cccc-0000-0000-000000000001',
   '66666666-eeee-0000-0000-000000000002', true, 'user-pta');

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-pta', true);
SELECT set_config('app.current_tenant', '66666666-cccc-6666-6666-666666666666', true);
SELECT set_config('app.current_departments', 'field-ops', true);

-- 1) a live token resolves to exactly its (tenant, customer)
SELECT is(
  (SELECT customer_id FROM app.portal_context('66666666-eeee-0000-0000-000000000001')),
  '66666666-cccc-0000-0000-000000000001'::uuid,
  'live portal token resolves to its customer');

-- 2) a REVOKED token resolves to nothing
SELECT is(
  (SELECT count(*) FROM app.portal_context('66666666-eeee-0000-0000-000000000002'))::int,
  0, 'revoked token resolves to nothing');

-- 3) an unknown token resolves to nothing
SELECT is(
  (SELECT count(*) FROM app.portal_context('00000000-0000-0000-0000-000000000000'))::int,
  0, 'unknown token resolves to nothing');

-- 4) a portal token cannot point at another tenant's customer (composite FK)
SELECT throws_ok($$
  INSERT INTO portal_tokens(tenant_id, customer_id, created_by)
  VALUES ('66666666-cccc-6666-6666-666666666666', '66666666-dddd-0000-0000-000000000001', 'user-pta')
$$, '23503', NULL, 'cross-tenant portal token is an FK violation');

-- 5) RLS: tenant B sees none of A's tokens
SELECT set_config('app.current_uid', 'user-ptb', true);
SELECT set_config('app.current_tenant', '66666666-dddd-6666-6666-666666666666', true);
SELECT is((SELECT count(*) FROM portal_tokens)::int, 0, 'tenant B sees 0 tokens of A');

SELECT * FROM finish();
ROLLBACK;
