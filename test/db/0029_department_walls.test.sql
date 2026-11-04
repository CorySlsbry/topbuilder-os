-- pgTAP for migration 0029 — department walls enforced by the DATABASE.
--
-- The security review found /api/wip and /api/jobs/[id]/costing shipping with
-- a bare requireScope(), and /api/agents/overview returning every action
-- PAYLOAD (raw bank lines, vendor amounts, per-worker burdened pay) to any
-- member. The routes are fixed; these assertions prove the BACKSTOP, so the
-- next forgotten route fails closed instead of leaking.
--
-- The shape that matters: same tenant, same authenticated user, ONLY the
-- department grant differs. Tenant isolation is not what is under test here —
-- 0001 covers that — this is the wall INSIDE a tenant.
BEGIN;
SELECT plan(8);

INSERT INTO tenants(id, name, slug) VALUES
  ('99999999-aaaa-9999-9999-999999999999', 'Dept A', 'dept-a');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('99999999-aaaa-9999-9999-999999999999', 'user-fin', 'staff'),
  ('99999999-aaaa-9999-9999-999999999999', 'user-field', 'staff');
INSERT INTO bank_accounts(id, tenant_id, name, gl_account_code) VALUES
  ('99999999-bbbb-9999-9999-999999999999', '99999999-aaaa-9999-9999-999999999999',
   'Ops checking', '1010');
INSERT INTO bank_transactions(tenant_id, bank_account_id, posted_on, description,
                              amount_cents, fingerprint)
VALUES ('99999999-aaaa-9999-9999-999999999999', '99999999-bbbb-9999-9999-999999999999',
        '2026-07-01', 'ABC SUPPLY 842.00', -84200, 'dept-test-1');
INSERT INTO agent_actions
  (tenant_id, agent_key, kind, payload, summary, idempotency_key, proposed_by, department_key)
VALUES
  ('99999999-aaaa-9999-9999-999999999999', 'financials', 'bank.categorize',
   '{"amountCents":-84200,"description":"ABC SUPPLY 842.00"}', 'Categorize $842.00',
   'dept-test-fin', 'agent:financials', 'financials'),
  ('99999999-aaaa-9999-9999-999999999999', 'workforce', 'time.postWeek',
   '{"workerName":"Sal Ortiz","totalCents":184300}', 'Post Sal Ortiz week',
   'dept-test-hr', 'agent:workforce', 'hr'),
  ('99999999-aaaa-9999-9999-999999999999', 'dispatch', 'dispatch.assign',
   '{"appointmentId":"x"}', 'Assign appointment',
   'dept-test-none', 'agent:dispatch', NULL);

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-fin', true);
SELECT set_config('app.current_tenant', '99999999-aaaa-9999-9999-999999999999', true);

-- ---------------------------------------------- holding the financials wall
SELECT set_config('app.current_departments', 'financials', true);
SELECT is((SELECT count(*) FROM bank_transactions)::int, 1,
  'financials sees the bank line');
SELECT is((SELECT count(*) FROM agent_actions)::int, 2,
  'financials sees its own card + the unwalled one, not the HR card');

-- ------------------------------------------------- holding only field-ops
-- Same tenant, same user, ONLY the grant changed.
SELECT set_config('app.current_departments', 'field', true);
SELECT is((SELECT count(*) FROM bank_transactions)::int, 0,
  'field sees 0 bank lines');
SELECT is((SELECT count(*) FROM agent_actions)::int, 1,
  'field sees only the unwalled dispatch card — no bank line, no worker pay');

-- ---------------------------------------------------- holding NO department
-- The fail-closed case: an unset department scope must yield nothing walled,
-- the same way an unset tenant scope yields nothing at all.
SELECT set_config('app.current_departments', '', true);
SELECT is((SELECT count(*) FROM bank_transactions)::int, 0,
  'no departments -> 0 bank lines (fail closed)');
SELECT is((SELECT count(*) FROM agent_actions)::int, 1,
  'no departments -> only unwalled cards');

-- ------------------------------------------------------------ WRITE side
-- Reads are half the wall; a walled row must not be WRITABLE either.
SELECT set_config('app.current_departments', 'field', true);
SELECT throws_ok($$
  INSERT INTO bank_transactions(tenant_id, bank_account_id, posted_on, description,
                                amount_cents, fingerprint)
  VALUES ('99999999-aaaa-9999-9999-999999999999', '99999999-bbbb-9999-9999-999999999999',
          '2026-07-02', 'sneaky', -100, 'dept-test-2')
$$, '42501', NULL, 'field cannot INSERT a bank line');

SELECT throws_ok($$
  INSERT INTO agent_actions
    (tenant_id, agent_key, kind, payload, summary, idempotency_key, proposed_by, department_key)
  VALUES ('99999999-aaaa-9999-9999-999999999999', 'financials', 'bank.categorize',
          '{}', 'x', 'dept-test-3', 'agent:financials', 'financials')
$$, '42501', NULL, 'field cannot INSERT a financials-walled card');

SELECT * FROM finish();
ROLLBACK;
