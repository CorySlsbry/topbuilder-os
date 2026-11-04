-- The public, no-login demo of Desert Aire Mechanical.
--
-- The strongest trust lever a studio has is PROOF OF WORK — show the real
-- thing, running, with numbers that tie. Desert Aire has been fully seeded
-- (eleven people, memberships with per-visit revenue recognition, equipment
-- history, books that balance) and nobody outside this machine has ever seen
-- it. This makes it visitable.
--
-- ── Why this needs no new authorization concept ────────────────────────────
--
-- The demo principal is an ordinary MEMBERSHIP: role `viewer`, granted every
-- department. That reuses the entire existing enforcement spine — RLS scopes
-- it to Desert Aire, the department grants let it read the money screens
-- (which is the whole point of the demo), and `viewer` is excluded from every
-- WRITE_ROLES / BOOKS_ROLES gate.
--
-- That last part only became true in the same commit as this migration.
-- Twelve mutating routes required a department but no ROLE, so `viewer` could
-- import bank statements, reconcile, create vendors and bills, and issue
-- invoices. A public demo on top of that would have been a public write
-- endpoint. BOOKS_ROLES fixed it and a structural test now holds the line.
--
-- Belt and braces: requireScope() PINS this principal to viewer regardless of
-- what its membership row says, so a future migration, script or misclick
-- promoting that row changes nothing. (A proxy-level method block was
-- considered and rejected — the proxy is sync and cannot read the sealed
-- session, and a marker cookie would be client-removable, so it would have
-- been a comfort layer rather than a real one.)
--
-- The data is safe to expose by construction: Desert Aire is FICTIONAL. Every
-- name, address, job and dollar in it was invented for this purpose.

-- ── The demo seat is not a billable seat ──────────────────────────────────
-- The seat-cap trigger refused this insert on the first run: Desert Aire is
-- at 10 of 10. That is the cap working exactly as designed — and it is right
-- that a marketing surface cannot quietly consume a seat a shop pays for.
--
-- The trigger already models "free seat" for the CPA/bookkeeper. The public
-- demo principal is the same category: not a person doing work in the shop,
-- so it neither consumes nor counts. Extending the existing exemption is the
-- honest fix; raising Desert Aire's cap would have hidden the rule instead of
-- expressing it.
CREATE OR REPLACE FUNCTION app.enforce_seat_cap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $fn$
DECLARE
  v_cap   int;
  v_used  int;
BEGIN
  -- The CPA/bookkeeper seat is free and never counts against the cap.
  -- Neither does the read-only public demo principal (migration 0039).
  IF NEW.role = 'bookkeeper' OR NEW.user_id = 'demo:public' THEN
    RETURN NEW;
  END IF;

  SELECT seat_cap INTO v_cap
    FROM subscriptions
   WHERE tenant_id = NEW.tenant_id
   FOR UPDATE;

  IF v_cap IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_used
    FROM memberships
   WHERE tenant_id = NEW.tenant_id
     AND role <> 'bookkeeper'
     AND user_id <> 'demo:public';

  IF v_used >= v_cap THEN
    RAISE EXCEPTION 'seat_limit_reached: % of % seats already used', v_used, v_cap
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

DO $$
DECLARE v_tenant uuid; v_membership uuid; v_dept record;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'desert-aire';
  IF v_tenant IS NULL THEN
    RAISE NOTICE 'desert-aire tenant not present; demo membership skipped';
    RETURN;
  END IF;

  PERFORM set_config('app.current_tenant', v_tenant::text, true);

  INSERT INTO memberships (tenant_id, user_id, role)
  VALUES (v_tenant, 'demo:public', 'viewer')
  ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'viewer';

  SELECT id INTO v_membership FROM memberships
   WHERE tenant_id = v_tenant AND user_id = 'demo:public';

  -- Every department: the demo is worthless if the visitor can't open the
  -- books, and reading is all it can do.
  FOR v_dept IN SELECT id FROM departments WHERE tenant_id = v_tenant LOOP
    INSERT INTO member_department_access (tenant_id, membership_id, department_id)
    VALUES (v_tenant, v_membership, v_dept.id)
    ON CONFLICT (membership_id, department_id) DO NOTHING;
  END LOOP;

  PERFORM set_config('app.current_tenant', '', true);
  RAISE NOTICE 'demo:public seated as viewer on desert-aire with all departments';
END $$;

COMMENT ON TABLE memberships IS
  'Tenant membership + role. NOTE: user_id ''demo:public'' is the read-only '
  'public demo principal on the desert-aire tenant (migration 0039). It is a '
  'viewer with every department grant; src/proxy.ts additionally refuses any '
  'non-GET request it makes.';
