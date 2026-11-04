-- pgTAP tests for the QBO bridge tables (migration 0011).
BEGIN;
SELECT plan(5);

INSERT INTO tenants(id, name, slug) VALUES
  ('55555555-5555-5555-5555-555555555555', 'Qbo A', 'qbo-a'),
  ('44444444-4444-4444-4444-444444444444', 'Qbo B', 'qbo-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('55555555-5555-5555-5555-555555555555', 'user-qa', 'owner'),
  ('44444444-4444-4444-4444-444444444444', 'user-qb', 'owner');
INSERT INTO qbo_connections(tenant_id, realm_id, access_token_enc, refresh_token_enc,
                            access_expires_at, refresh_expires_at, connected_by)
VALUES ('55555555-5555-5555-5555-555555555555', 'realm-1', 'enc-a', 'enc-r',
        now() + interval '1 hour', now() + interval '100 days', 'user-qa');
INSERT INTO qbo_entity_map(tenant_id, local_type, local_id, qbo_type, qbo_id)
VALUES ('55555555-5555-5555-5555-555555555555', 'account', '1020', 'Account', '81');

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-qa', true);
SELECT set_config('app.current_tenant', '55555555-5555-5555-5555-555555555555', true);
SELECT set_config('app.current_departments', 'financials', true);

-- 1) one QBO connection per tenant
SELECT throws_ok($$
  INSERT INTO qbo_connections(tenant_id, realm_id, access_token_enc, refresh_token_enc,
                              access_expires_at, refresh_expires_at, connected_by)
  VALUES ('55555555-5555-5555-5555-555555555555', 'realm-2', 'x', 'y',
          now(), now(), 'user-qa')
$$, '23505', NULL, 'second connection for a tenant is rejected');

-- 2) entity map is unique per (tenant, qbo entity)
SELECT throws_ok($$
  INSERT INTO qbo_entity_map(tenant_id, local_type, local_id, qbo_type, qbo_id)
  VALUES ('55555555-5555-5555-5555-555555555555', 'account', '1030', 'Account', '81')
$$, '23505', NULL, 'duplicate qbo entity in the map is rejected');

-- 3) RLS: tenant B sees nothing of A (connections would leak tokens!)
SELECT set_config('app.current_uid', 'user-qb', true);
SELECT set_config('app.current_tenant', '44444444-4444-4444-4444-444444444444', true);
SELECT is((SELECT count(*) FROM qbo_connections)::int, 0, 'tenant B sees 0 connections of A');
SELECT is((SELECT count(*) FROM qbo_entity_map)::int, 0, 'tenant B sees 0 map rows of A');

-- 4) cross-tenant write is blocked (WITH CHECK)
SELECT throws_ok($$
  INSERT INTO qbo_sync_state(tenant_id) VALUES ('55555555-5555-5555-5555-555555555555')
$$, '42501', NULL, 'tenant B cannot write sync state for A');

SELECT * FROM finish();
ROLLBACK;
