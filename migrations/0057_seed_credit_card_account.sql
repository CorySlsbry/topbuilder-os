-- 0057 — actually seed 2150, because 0054 only appeared to.
--
-- ⛔ A SET-BASED INSERT ACROSS TENANTS DOES NOTHING UNDER FORCE RLS.
--
-- Migration 0054 added `Credit cards payable` with:
--
--     INSERT INTO chart_of_accounts (...)
--     SELECT t.id, '2150', ... FROM tenants t
--      WHERE EXISTS (SELECT 1 FROM chart_of_accounts a WHERE a.tenant_id = t.id)
--     ON CONFLICT DO NOTHING;
--
-- It reported success and inserted ZERO rows in every database it ran on.
--
-- `chart_of_accounts` is FORCE ROW LEVEL SECURITY, and on this Cloud SQL
-- instance `postgres` is `rolbypassrls = false` — verified again just now:
-- an unscoped `SELECT count(*) FROM chart_of_accounts` as the owner returns
-- 0 against a database holding 828 rows. So the EXISTS subquery saw nothing,
-- matched no tenant, and the INSERT had no rows to insert. `ON CONFLICT DO
-- NOTHING` then made the whole thing look deliberate.
--
-- This is the SAME failure this codebase has hit repeatedly — it is why
-- migration 0037 seeds account 3138 with a per-tenant loop, why 0041 exists
-- at all, and why the proof scripts read the directory table first. There is
-- a Build-Law about it. It was written anyway, and 0054's own probe passed
-- because it only asserted that a CHECK constraint had landed, never that a
-- ROW had.
--
-- The fix is the loop 0037 already established: one tenant at a time, with
-- `app.current_tenant` set, so the policy can actually match.
--
-- Consequence if left: adding a credit-card bank account throws
-- `unknown_account:2150` at posting time — on the screen somebody is halfway
-- through connecting their bank.

DO $$
DECLARE
  t        record;
  seeded   int := 0;
  skipped  int := 0;
BEGIN
  -- `tenants` is ENABLE-only, never FORCE (the directory-table nuance from
  -- 0001), so this loop is readable without a GUC. That is precisely why the
  -- directory is the entry point for every cross-tenant operation here.
  FOR t IN SELECT id, slug FROM tenants ORDER BY created_at LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    -- A tenant with no chart at all has not been seeded yet and will get 2150
    -- from the CSV when it is (0054 added it there). Inserting into an empty
    -- chart would leave one lonely liability account and nothing else.
    IF EXISTS (SELECT 1 FROM chart_of_accounts) THEN
      INSERT INTO chart_of_accounts (tenant_id, code, name, type, section, description, tag)
      VALUES (
        t.id, '2150', 'Credit cards payable', 'liability',
        '2000-2990 Liabilities and Owners'' Equity',
        'Outstanding balances on business credit cards', 'liability'
      )
      ON CONFLICT (tenant_id, code) DO NOTHING;
      seeded := seeded + 1;
    ELSE
      skipped := skipped + 1;
    END IF;
  END LOOP;

  RAISE NOTICE '2150 seeded for % tenant(s); % had no chart yet', seeded, skipped;
END $$;

-- ── proof, and this time it checks for a ROW ─────────────────────────────
-- 0054's probe asserted a CHECK constraint existed. That is not the same
-- claim as "the data landed", and the difference is this migration.
DO $$
DECLARE
  t       record;
  missing text[] := '{}';
BEGIN
  FOR t IN SELECT id, slug FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);
    IF EXISTS (SELECT 1 FROM chart_of_accounts)
       AND NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE code = '2150') THEN
      missing := missing || t.slug;
    END IF;
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION
      'tenants still missing the credit-card account 2150: %', array_to_string(missing, ', ');
  END IF;
  RAISE NOTICE 'every seeded chart has a credit-card account';
END $$;
