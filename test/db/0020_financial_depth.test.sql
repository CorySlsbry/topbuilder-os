-- pgTAP tests for financial depth (migration 0020) + the CPA invite path.
--
-- History worth keeping: this suite used to assert against `payroll_runs`,
-- which migration 0028 dropped when payroll left the product. The file then
-- aborted on its first INSERT and ran 0 of 6 planned assertions — and the old
-- runner reported that as a PASS. Both halves are fixed: scripts/pgtap.mjs now
-- compares assertions run against plan(N), and the three payroll assertions
-- are replaced by ones covering what actually still ships.
--
-- The advisor-invite path is the sharpest thing left in 0020: it is the one
-- SECURITY DEFINER function that hands a person OUTSIDE the company a
-- membership, so its blast radius is checked here rather than assumed.
BEGIN;
SELECT plan(6);

INSERT INTO tenants(id, name, slug) VALUES
  ('77777777-cccc-7777-7777-777777777777', 'Fd A', 'fd-a'),
  ('77777777-dddd-7777-7777-777777777777', 'Fd B', 'fd-b');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('77777777-cccc-7777-7777-777777777777', 'user-fda', 'owner'),
  ('77777777-dddd-7777-7777-777777777777', 'user-fdb', 'owner');
-- Departments must exist for the grant half of redemption (migration 0021).
INSERT INTO departments(tenant_id, key, name) VALUES
  ('77777777-cccc-7777-7777-777777777777', 'financials', 'Money & books');
INSERT INTO advisor_invites(tenant_id, code, created_by) VALUES
  ('77777777-cccc-7777-7777-777777777777', '77777777-eeee-0000-0000-000000000001', 'user-fda');

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-fda', true);
SELECT set_config('app.current_tenant', '77777777-cccc-7777-7777-777777777777', true);
SELECT set_config('app.current_departments', 'financials', true);

-- 1) an invite can never mint a privileged role, whatever the caller asks for
SELECT throws_ok($$
  INSERT INTO advisor_invites(tenant_id, code, role, created_by)
  VALUES ('77777777-cccc-7777-7777-777777777777',
          '77777777-eeee-0000-0000-000000000009', 'owner', 'user-fda')
$$, '23514', NULL, 'an advisor invite cannot mint an owner');

-- 2) redeeming a valid invite returns its tenant
SELECT is(
  app.redeem_advisor_invite('77777777-eeee-0000-0000-000000000001', 'cpa-jane'),
  '77777777-cccc-7777-7777-777777777777'::uuid,
  'valid invite redeems to its tenant');

-- 3) ...and joins the CPA as a bookkeeper, not anything sharper
SELECT is(
  (SELECT role FROM memberships WHERE user_id = 'cpa-jane'
    AND tenant_id = '77777777-cccc-7777-7777-777777777777'),
  'bookkeeper', 'CPA joined as bookkeeper');

-- 4) ...with the financials wall granted, so the CPA can actually do the job.
--    This is what makes the department-walled routes usable by the CPA seat —
--    without it, adding walls to /api/wip and friends would lock out the
--    accountant we sell a free seat to.
SELECT is(
  (SELECT count(*) FROM member_department_access mda
     JOIN memberships m ON m.id = mda.membership_id
     JOIN departments d ON d.id = mda.department_id
    WHERE m.user_id = 'cpa-jane' AND d.key = 'financials')::int,
  1, 'CPA got the financials department grant');

-- 5) a used invite cannot be redeemed again
SELECT is(
  app.redeem_advisor_invite('77777777-eeee-0000-0000-000000000001', 'cpa-mallory'),
  NULL, 'used invite redeems to nothing');

-- 6) RLS: tenant B sees none of A's invites
SELECT set_config('app.current_uid', 'user-fdb', true);
SELECT set_config('app.current_tenant', '77777777-dddd-7777-7777-777777777777', true);
SELECT is((SELECT count(*) FROM advisor_invites)::int, 0,
  'tenant B sees 0 advisor invites of A');

SELECT * FROM finish();
ROLLBACK;
