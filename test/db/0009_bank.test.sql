-- pgTAP tests for the bank plane (migration 0009).
BEGIN;
SELECT plan(7);

INSERT INTO tenants(id, name, slug) VALUES
  ('77777777-7777-7777-7777-777777777777', 'Bank A', 'bank-a'),
  ('66666666-6666-6666-6666-666666666666', 'Bank B', 'bank-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('77777777-7777-7777-7777-777777777777', 'user-bka', 'owner'),
  ('66666666-6666-6666-6666-666666666666', 'user-bkb', 'owner');
INSERT INTO bank_accounts(id, tenant_id, name, gl_account_code) VALUES
  ('77777777-0000-0000-0000-000000000001', '77777777-7777-7777-7777-777777777777', 'Checking', '1020');
INSERT INTO bank_transactions(tenant_id, bank_account_id, posted_on, amount_cents, description, fingerprint) VALUES
  ('77777777-7777-7777-7777-777777777777', '77777777-0000-0000-0000-000000000001',
   '2026-07-01', -84200, 'HOME DEPOT #1234', 'fp-1');

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-bka', true);
SELECT set_config('app.current_tenant', '77777777-7777-7777-7777-777777777777', true);
SELECT set_config('app.current_departments', 'financials', true);

-- 1) fingerprint dedupe: same (account, fingerprint) cannot insert twice
SELECT throws_ok($$
  INSERT INTO bank_transactions(tenant_id, bank_account_id, posted_on, amount_cents, description, fingerprint)
  VALUES ('77777777-7777-7777-7777-777777777777', '77777777-0000-0000-0000-000000000001',
          '2026-07-01', -84200, 'HOME DEPOT #1234', 'fp-1')
$$, '23505', NULL, 'duplicate fingerprint on the same account is rejected');

-- 2) zero-amount transactions are impossible
SELECT throws_ok($$
  INSERT INTO bank_transactions(tenant_id, bank_account_id, posted_on, amount_cents, description, fingerprint)
  VALUES ('77777777-7777-7777-7777-777777777777', '77777777-0000-0000-0000-000000000001',
          '2026-07-01', 0, 'zero', 'fp-zero')
$$, '23514', NULL, 'zero-amount bank transaction violates the CHECK');

-- 3) reconciliations are append-only at the grant layer
INSERT INTO reconciliations(tenant_id, bank_account_id, period_end, txn_count, reconciled_by)
VALUES ('77777777-7777-7777-7777-777777777777', '77777777-0000-0000-0000-000000000001',
        '2026-07-31', 1, 'user-bka');
SELECT throws_ok($$ DELETE FROM reconciliations $$, '42501', NULL,
  'reconciliations DELETE denied at the grant layer');

-- 4) one reconciliation per account per period end
SELECT throws_ok($$
  INSERT INTO reconciliations(tenant_id, bank_account_id, period_end, txn_count)
  VALUES ('77777777-7777-7777-7777-777777777777', '77777777-0000-0000-0000-000000000001', '2026-07-31', 1)
$$, '23505', NULL, 'duplicate reconciliation for a period is rejected');

-- 5) RLS: tenant B sees none of A's bank data
SELECT set_config('app.current_uid', 'user-bkb', true);
SELECT set_config('app.current_tenant', '66666666-6666-6666-6666-666666666666', true);
SELECT is((SELECT count(*) FROM bank_transactions)::int, 0, 'tenant B sees 0 bank txns of A');
SELECT is((SELECT count(*) FROM bank_rules)::int, 0, 'tenant B sees 0 rules of A');

-- 6) reconciliation immutability trigger holds even as superuser
RESET ROLE;
SELECT throws_ok($$ DELETE FROM reconciliations $$, 'P0001', NULL,
  'reconciliations immutable trigger holds even as superuser');

SELECT * FROM finish();
ROLLBACK;
