-- pgTAP tests for the agent framework (migration 0012).
BEGIN;
SELECT plan(7);

INSERT INTO tenants(id, name, slug) VALUES
  ('33333333-3333-3333-3333-333333333333', 'Ag A', 'ag-a'),
  ('22222222-2222-2222-2222-222222222222', 'Ag B', 'ag-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333', 'user-aga', 'owner'),
  ('22222222-2222-2222-2222-222222222222', 'user-agb', 'owner');
INSERT INTO agent_actions(id, tenant_id, agent_key, kind, payload, summary, idempotency_key, proposed_by)
VALUES ('33333333-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333',
        'echo', 'echo.write', '{}', 'Echo: test', 'k-1', 'agent:echo');
INSERT INTO audit_events(tenant_id, actor, to_status)
VALUES ('33333333-3333-3333-3333-333333333333', 'agent:echo', 'proposed');

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-aga', true);
SELECT set_config('app.current_tenant', '33333333-3333-3333-3333-333333333333', true);
SELECT set_config('app.current_departments', 'financials', true);

-- 1) idempotency: same (tenant, key) cannot insert twice
SELECT throws_ok($$
  INSERT INTO agent_actions(tenant_id, agent_key, kind, payload, summary, idempotency_key, proposed_by)
  VALUES ('33333333-3333-3333-3333-333333333333', 'echo', 'echo.write', '{}', 'dup', 'k-1', 'agent:echo')
$$, '23505', NULL, 'duplicate idempotency key is rejected');

-- 2) maker != checker at the DB
SELECT throws_ok($$
  UPDATE agent_actions SET decided_by = 'agent:echo'
   WHERE id = '33333333-0000-0000-0000-000000000001'
$$, '23514', NULL, 'proposer cannot be the decider (CHECK)');

-- 3) audit trail is append-only at the grant layer
SELECT throws_ok($$ DELETE FROM audit_events $$, '42501',
  NULL, 'audit_events DELETE denied at grant layer');

-- 4) learning events append-only too
INSERT INTO learning_events(tenant_id, agent_key, event, actor)
VALUES ('33333333-3333-3333-3333-333333333333', 'echo', 'test', 'user-aga');
SELECT throws_ok($$ UPDATE learning_events SET event = 'x' $$, '42501',
  NULL, 'learning_events UPDATE denied at grant layer');

-- 5) RLS: tenant B sees none of A's actions or cases
SELECT set_config('app.current_uid', 'user-agb', true);
SELECT set_config('app.current_tenant', '22222222-2222-2222-2222-222222222222', true);
SELECT is((SELECT count(*) FROM agent_actions)::int, 0, 'tenant B sees 0 actions of A');
SELECT is((SELECT count(*) FROM learning_events)::int, 0,
  'tenant B sees 0 learning events of A (poisoned cases cannot cross tenants)');

-- 6) audit immutability trigger holds even as superuser
RESET ROLE;
SELECT throws_ok($$ DELETE FROM audit_events $$, 'P0001', NULL,
  'audit_events immutable even as superuser');

SELECT * FROM finish();
ROLLBACK;
