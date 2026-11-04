-- pgTAP tests for the double-entry ledger invariants (migration 0002).
-- Fixtures as superuser; invariant attacks as app_user under RLS.
-- NOTE: valid multi-line entries insert ALL lines in ONE statement — with
-- `SET CONSTRAINTS ... IMMEDIATE` the balance trigger fires at end-of-statement.
BEGIN;
SELECT plan(16);

-- ------------------------------------------------------------------ fixtures
INSERT INTO tenants(id, name, slug) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Ledger A', 'ledger-a'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Ledger B', 'ledger-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'user-la', 'owner'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'user-lb', 'owner');

INSERT INTO chart_of_accounts(id, tenant_id, code, name, type) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '1020', 'Cash, general',        'asset'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '1210', 'Accounts receivable',  'asset'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '3010', 'Revenue',              'revenue'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '1020', 'Cash, general',        'asset');

-- A pre-existing balanced entry for tenant A (fixture, as superuser).
INSERT INTO journal_entries(id, tenant_id, occurred_on, memo) VALUES
  ('aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-05-15', 'fixture invoice');
INSERT INTO journal_lines(tenant_id, entry_id, account_id, debit_cents, credit_cents) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 150000, 0),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 0, 150000);

-- A CLOSED period for tenant A: June 2026.
INSERT INTO fiscal_periods(tenant_id, period_start, status, closed_at) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-06-01', 'closed', now());

-- ------------------------------------------------- attacks as app_user
SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-la', true);
SELECT set_config('app.current_tenant', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
SELECT set_config('app.current_departments', 'financials', true);
-- Make the balance trigger fire at end of each statement for these tests.
SET CONSTRAINTS journal_lines_balanced IMMEDIATE;

-- 1) a BALANCED entry posts (all lines in one statement)
INSERT INTO journal_entries(id, tenant_id, occurred_on, memo) VALUES
  ('aaaaaaaa-1111-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-05-20', 'cash receipt');
SELECT lives_ok($$
  INSERT INTO journal_lines(tenant_id, entry_id, account_id, debit_cents, credit_cents) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 150000, 0),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 0, 150000)
$$, 'a balanced entry posts');

-- 2) an UNBALANCED entry is rejected
INSERT INTO journal_entries(id, tenant_id, occurred_on, memo) VALUES
  ('aaaaaaaa-1111-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-05-21', 'bad entry');
SELECT throws_ok($$
  INSERT INTO journal_lines(tenant_id, entry_id, account_id, debit_cents, credit_cents) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 100000, 0),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000003', 0, 99999)
$$, 'P0001', NULL, 'an unbalanced entry cannot post');

-- 3) a SINGLE-line entry is rejected (needs >= 2 lines)
INSERT INTO journal_entries(id, tenant_id, occurred_on, memo) VALUES
  ('aaaaaaaa-1111-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-05-22', 'single line');
SELECT throws_ok($$
  INSERT INTO journal_lines(tenant_id, entry_id, account_id, debit_cents, credit_cents) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 500, 0)
$$, 'P0001', NULL, 'a single-line entry cannot post');

-- 4) a line with BOTH debit and credit set violates the one-sided CHECK
SELECT throws_ok($$
  INSERT INTO journal_lines(tenant_id, entry_id, account_id, debit_cents, credit_cents) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 100, 100)
$$, '23514', NULL, 'a two-sided line violates the CHECK');

-- 5) a line with NEITHER side set violates the CHECK
SELECT throws_ok($$
  INSERT INTO journal_lines(tenant_id, entry_id, account_id, debit_cents, credit_cents) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 0, 0)
$$, '23514', NULL, 'a zero-zero line violates the CHECK');

-- 6) append-only, layer 1 — the GRANT: app_user has no UPDATE privilege at all
SELECT throws_ok($$
  UPDATE journal_lines SET debit_cents = 1
   WHERE entry_id = 'aaaaaaaa-1111-0000-0000-000000000001'
$$, '42501', NULL, 'UPDATE of a posted line is denied at the grant layer');

-- 7) append-only, layer 1 — DELETE likewise denied by grant
SELECT throws_ok($$
  DELETE FROM journal_entries WHERE id = 'aaaaaaaa-1111-0000-0000-000000000001'
$$, '42501', NULL, 'DELETE of a posted entry is denied at the grant layer');

-- 8) posting into a CLOSED period is rejected
SELECT throws_ok($$
  INSERT INTO journal_entries(tenant_id, occurred_on, memo) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-06-10', 'into closed june')
$$, 'P0001', NULL, 'posting into a closed fiscal period is rejected');

-- 9) an OPEN month still accepts postings (may 2026 has no period row = open)
SELECT lives_ok($$
  INSERT INTO journal_entries(tenant_id, occurred_on, memo) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-05-25', 'open month ok')
$$, 'posting into an open month is accepted');

-- 10) cross-tenant reference: tenant A cannot post a line against tenant B's
--     account (composite FK pins account to the same tenant)
SELECT throws_ok($$
  INSERT INTO journal_lines(tenant_id, entry_id, account_id, debit_cents, credit_cents) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', 100, 0)
$$, '23503', NULL, 'a line cannot reference another tenant''s account');

-- 11) trial balance balances for tenant A (as app_user, under RLS)
SELECT is(
  (SELECT COALESCE(SUM(debit_cents) - SUM(credit_cents), -1)::bigint
     FROM journal_lines),
  0::bigint,
  'trial balance: total debits equal total credits');

-- 12) RLS: tenant B sees ZERO of tenant A''s journal
SELECT set_config('app.current_uid', 'user-lb', true);
SELECT set_config('app.current_tenant', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true);
SELECT is((SELECT count(*) FROM journal_entries)::int, 0,
  'tenant B sees zero of tenant A journal entries');

-- 13/14) grant-level append-only: app_user simply has no UPDATE/DELETE
RESET ROLE;
SELECT is(has_table_privilege('app_user', 'journal_lines', 'UPDATE'), false,
  'app_user has no UPDATE on journal_lines');
SELECT is(has_table_privilege('app_user', 'journal_entries', 'DELETE'), false,
  'app_user has no DELETE on journal_entries');

-- 15/16) append-only, layer 2 — the TRIGGER holds even for a privileged role
-- (defense in depth: if a grant were ever widened by mistake, the ledger
-- still refuses mutation).
SELECT throws_ok($$
  UPDATE journal_lines SET debit_cents = 1
   WHERE entry_id = 'aaaaaaaa-1111-0000-0000-000000000001'
$$, 'P0001', NULL, 'immutability trigger rejects UPDATE even as superuser');
SELECT throws_ok($$
  DELETE FROM journal_entries WHERE id = 'aaaaaaaa-1111-0000-0000-000000000001'
$$, 'P0001', NULL, 'immutability trigger rejects DELETE even as superuser');

SELECT * FROM finish();
ROLLBACK;
