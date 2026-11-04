-- Make "delete my business" actually delete the business.
--
-- THE BUG: app.purge_current_tenant() made exactly TWO passes over the tenant
-- tables in alphabetical order. The first pass swallowed foreign-key
-- violations on the assumption that one more pass would find the children
-- already gone. The second pass had no handler at all.
--
-- Two passes only settle a dependency graph two levels deep. This schema is
-- four to five:
--
--     estimate_lines -> estimate_options -> estimates -> jobs -> customers
--     journal_lines  -> journal_entries
--     invoices       -> jobs            -> customers
--
-- Alphabetical order puts `customers` first, long before `jobs`. Pass one:
-- customers fails (jobs reference it) and is skipped; jobs fails (invoices and
-- estimates reference it) and is skipped. Pass two reaches customers again
-- with jobs still present — and throws:
--
--     ERROR: update or delete on table "customers" violates foreign key
--     constraint "jobs_tenant_id_customer_id_fkey" on table "jobs"
--     DETAIL: Key is still referenced from table "jobs".
--
-- So a tenant with any real history could not be deleted. That is a shipped,
-- advertised feature — the anti-dark-pattern promise that your data is yours
-- and you can take it and go — and it would have failed at the worst possible
-- moment: a customer trying to leave. It survived review because the earlier
-- check ran against a tenant without the full object graph. Found 2026-07-27
-- when the demo seed tried to reset itself.
--
-- THE FIX: iterate to a FIXED POINT instead of guessing a pass count. Keep
-- sweeping while any pass still deletes something; stop when a whole pass
-- deletes nothing. That is correct for a dependency graph of any depth and any
-- shape, including ones added years from now — which matters, because the
-- failure mode of the old version was invisible until the schema grew.
--
-- Then VERIFY, and refuse to finish quietly if anything is left. A purge that
-- half-succeeds is worse than one that fails: the tenant is broken and the
-- user has been told their data is gone.

CREATE OR REPLACE FUNCTION app.purge_current_tenant()
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
  v_tenant    uuid := NULLIF(current_setting('app.current_tenant', true), '')::uuid;
  v_table     text;
  v_deleted   bigint := 0;
  v_count     bigint;
  v_progress  boolean;
  v_rounds    int := 0;
  v_remaining text;
BEGIN
  -- Takes NO tenant argument, by design: it reads the GUC, so it cannot be
  -- aimed at another tenant's data however it is called.
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant in scope — refusing to purge';
  END IF;

  PERFORM set_config('app.ledger_purge', 'on', true);

  LOOP
    v_progress := false;
    v_rounds := v_rounds + 1;

    FOR v_table IN
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY c.relname
    LOOP
      -- A sub-block per table: an FK violation rolls back only this DELETE,
      -- leaving earlier progress in this round intact.
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_table) USING v_tenant;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        IF v_count > 0 THEN
          v_deleted := v_deleted + v_count;
          v_progress := true;
        END IF;
      EXCEPTION WHEN foreign_key_violation THEN
        NULL; -- its children are still present; a later round will get it
      END;
    END LOOP;

    -- A round that deleted nothing means either everything is gone, or what
    -- remains is a cycle nothing can break. Either way, stop sweeping.
    EXIT WHEN NOT v_progress;

    -- Belt and braces against a pathological schema: the loop is bounded by
    -- progress, so this can only trip if something is very wrong.
    IF v_rounds > 50 THEN
      RAISE EXCEPTION 'purge did not converge after % rounds', v_rounds;
    END IF;
  END LOOP;

  -- VERIFY. Never report success on a partial delete: the caller has already
  -- told a human their data is gone.
  FOR v_table IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id = $1', v_table)
      INTO v_count USING v_tenant;
    IF v_count > 0 THEN
      v_remaining := concat_ws(', ', v_remaining, format('%s(%s)', v_table, v_count));
    END IF;
  END LOOP;

  IF v_remaining IS NOT NULL THEN
    RAISE EXCEPTION 'purge incomplete — rows remain in: %', v_remaining;
  END IF;

  DELETE FROM tenants WHERE id = v_tenant;
  RETURN v_deleted;
END $$;

REVOKE ALL ON FUNCTION app.purge_current_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_current_tenant() TO app_user;

COMMENT ON FUNCTION app.purge_current_tenant() IS
  'Self-service tenant delete. Sweeps to a fixed point (any FK depth), then '
  'VERIFIES nothing remains before dropping the tenant row. Takes no tenant '
  'argument — reads app.current_tenant — so it cannot be aimed elsewhere.';
