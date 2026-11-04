-- pgTAP tests for intake (migration 0017).
BEGIN;
SELECT plan(4);

INSERT INTO tenants(id, name, slug) VALUES
  ('55555555-cccc-5555-5555-555555555555', 'In A', 'in-a'),
  ('55555555-dddd-5555-5555-555555555555', 'In B', 'in-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('55555555-cccc-5555-5555-555555555555', 'user-ina', 'owner'),
  ('55555555-dddd-5555-5555-555555555555', 'user-inb', 'owner');
INSERT INTO intake_requests(tenant_id, external_id, name, source) VALUES
  ('55555555-cccc-5555-5555-555555555555', 'call-001', 'Jane Caller', 'call');

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-ina', true);
SELECT set_config('app.current_tenant', '55555555-cccc-5555-5555-555555555555', true);
SELECT set_config('app.current_departments', 'field-ops', true);

-- 1) idempotency: the same call_id cannot land twice
SELECT throws_ok($$
  INSERT INTO intake_requests(tenant_id, external_id, name, source)
  VALUES ('55555555-cccc-5555-5555-555555555555', 'call-001', 'Jane Again', 'call')
$$, '23505', NULL, 'duplicate external_id per tenant is rejected');

-- 2) the slug lookup returns ONLY an id, and works without membership
SELECT is(
  app.tenant_id_by_slug('in-b'),
  '55555555-dddd-5555-5555-555555555555'::uuid,
  'tenant_id_by_slug resolves any slug (public booking entry)');
SELECT is(app.tenant_id_by_slug('nope'), NULL, 'unknown slug -> NULL');

-- 3) RLS: tenant B sees none of A's intake
SELECT set_config('app.current_uid', 'user-inb', true);
SELECT set_config('app.current_tenant', '55555555-dddd-5555-5555-555555555555', true);
SELECT is((SELECT count(*) FROM intake_requests)::int, 0, 'tenant B sees 0 intake of A');

SELECT * FROM finish();
ROLLBACK;
