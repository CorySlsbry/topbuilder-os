-- pgTAP for migration 0033 — self-service tenant delete, on a REAL object graph.
--
-- The old purge made exactly two passes and the second had no error handler,
-- so any tenant whose data was more than two foreign keys deep could not be
-- deleted:
--
--   ERROR: update or delete on table "customers" violates foreign key
--   constraint "jobs_tenant_id_customer_id_fkey" on table "jobs"
--
-- That is the advertised "your data is yours, leave whenever" promise failing
-- for exactly the customers who used the product. The earlier check passed
-- because it ran against a shallow fixture.
--
-- So this suite builds the DEPTH, not just a row per table:
--   customer -> job -> estimate -> option -> line   (5 levels)
BEGIN;
SELECT plan(6);

INSERT INTO tenants(id, name, slug) VALUES
  ('44444444-1111-4444-4444-444444444444', 'Purge Deep', 'purge-deep'),
  ('44444444-2222-4444-4444-444444444444', 'Bystander',  'purge-bystander');
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('44444444-1111-4444-4444-444444444444', 'user-purge', 'owner'),
  ('44444444-2222-4444-4444-444444444444', 'user-other', 'owner');

-- The deep chain, in the doomed tenant.
INSERT INTO customers(id, tenant_id, name) VALUES
  ('44444444-aaaa-4444-4444-444444444444', '44444444-1111-4444-4444-444444444444', 'Ruth Delgado');
INSERT INTO jobs(id, tenant_id, customer_id, job_no, name) VALUES
  ('44444444-bbbb-4444-4444-444444444444', '44444444-1111-4444-4444-444444444444',
   '44444444-aaaa-4444-4444-444444444444', 1, 'AC change-out');
INSERT INTO estimates(id, tenant_id, job_id) VALUES
  ('44444444-cccc-4444-4444-444444444444', '44444444-1111-4444-4444-444444444444',
   '44444444-bbbb-4444-4444-444444444444');
INSERT INTO estimate_options(id, tenant_id, estimate_id, tier, title, total_cents) VALUES
  ('44444444-dddd-4444-4444-444444444444', '44444444-1111-4444-4444-444444444444',
   '44444444-cccc-4444-4444-444444444444', 'better', 'Better', 185000);
INSERT INTO estimate_lines(tenant_id, option_id, description, qty_x100, unit_price_cents, line_total_cents)
VALUES ('44444444-1111-4444-4444-444444444444', '44444444-dddd-4444-4444-444444444444',
        'Crane rental — one-off', 100, 185000, 185000);

-- An identical chain in a DIFFERENT tenant, which must survive untouched.
INSERT INTO customers(id, tenant_id, name) VALUES
  ('44444444-eeee-4444-4444-444444444444', '44444444-2222-4444-4444-444444444444', 'Someone Else');
INSERT INTO jobs(id, tenant_id, customer_id, job_no, name) VALUES
  ('44444444-ffff-4444-4444-444444444444', '44444444-2222-4444-4444-444444444444',
   '44444444-eeee-4444-4444-444444444444', 1, 'Not yours');

SET ROLE app_user;
SELECT set_config('app.current_uid', 'user-purge', true);
SELECT set_config('app.current_tenant', '44444444-1111-4444-4444-444444444444', true);
SELECT set_config('app.current_departments', 'field,financials,hr', true);

-- 1) It completes at all. This is the assertion that would have failed before:
--    the five-deep chain made the old two-pass version throw.
SELECT lives_ok(
  $$ SELECT app.purge_current_tenant() $$,
  'purge completes on a 5-level foreign-key chain');

-- 2) ...and the deepest child is actually gone (not silently skipped).
SELECT is((SELECT count(*) FROM estimate_lines
            WHERE tenant_id = '44444444-1111-4444-4444-444444444444')::int,
          0, 'deepest child rows are gone');

-- 3) ...and the root parent is gone (the row the FK was protecting).
SELECT is((SELECT count(*) FROM customers
            WHERE tenant_id = '44444444-1111-4444-4444-444444444444')::int,
          0, 'root parent rows are gone');

-- 4) ...and the tenant itself no longer exists.
RESET ROLE;
SELECT is((SELECT count(*) FROM tenants
            WHERE id = '44444444-1111-4444-4444-444444444444')::int,
          0, 'the tenant row is removed');

-- 5) The bystander tenant is untouched — purge reads the GUC and takes no
--    argument, so it cannot reach across.
SELECT is((SELECT count(*) FROM jobs
            WHERE tenant_id = '44444444-2222-4444-4444-444444444444')::int,
          1, 'another tenant keeps its data');

-- 6) With no tenant in scope it refuses rather than doing something ambitious.
SET ROLE app_user;
SELECT set_config('app.current_tenant', '', true);
SELECT throws_ok(
  $$ SELECT app.purge_current_tenant() $$,
  NULL, NULL, 'refuses to run with no tenant in scope');

SELECT * FROM finish();
ROLLBACK;
