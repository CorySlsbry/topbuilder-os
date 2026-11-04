-- 0061 — Top Builder OS **Light**, $99/mo, one seat.
--
-- The fourth billable tier, and the first one that is SMALLER rather than
-- bigger. Two constraints from 0059 have to widen together: the plan CHECK
-- and the seat_cap-matches-plan CHECK that welds a plan to its cap 1:1.
--
-- ⛔ WHY A ONE-SEAT PLAN IS NOT A CONTRADICTION OF 0059's "the bottom rung
-- covers TWO people". That rule protects the owner's spouse doing the books,
-- and it still holds — because `app.enforce_seat_cap()` (migration 0025)
-- exempts the `bookkeeper` role from the cap entirely. So a Light tenant is
-- the operator on his one paid seat PLUS his wife on the free bookkeeper
-- seat. The household is intact; what Light drops is a second FIELD person,
-- which is precisely the moment the crew tools start earning their price.
--
-- ⛔ Light is a SMALLER PRODUCT, not a crippled one. The capability fence
-- lives in the application (src/modules/billing/internal/plans.ts +
-- entitlements.ts) and never in this schema: a plan column that also encoded
-- features would put marketing decisions in the database, where they cannot
-- be unit-tested and cannot be changed without a migration.
--
-- ⛔ The Stripe price `os_light_99` must exist (test AND live) before this
-- tier is offered. A plan the billing system cannot charge should not be in
-- the catalog — the rule 0059 recorded, restated here because a migration is
-- the easiest place to accidentally create one.

-- ── the plan CHECK ───────────────────────────────────────────────────────
-- Found in the catalog, not named on faith. 0050's lesson, still true: a
-- constraint created under an auto-generated name in one environment and an
-- explicit name in another makes a guessed DROP a production-only failure.
DO $$
DECLARE
  conname_found text;
BEGIN
  SELECT c.conname INTO conname_found
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'subscriptions'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%plan%'
     AND pg_get_constraintdef(c.oid) ILIKE '%solo%'
     AND pg_get_constraintdef(c.oid) NOT ILIKE '%seat_cap%'
   LIMIT 1;

  IF conname_found IS NULL THEN
    RAISE NOTICE 'no plan CHECK found on subscriptions; nothing to widen';
  ELSE
    EXECUTE format('ALTER TABLE subscriptions DROP CONSTRAINT %I', conname_found);
    RAISE NOTICE 'dropped % on subscriptions', conname_found;
  END IF;
END $$;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_check CHECK (plan IN ('light', 'solo', 'crew', 'shop'));

-- ── seat_cap must still match the plan ───────────────────────────────────
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_seat_cap_matches_plan;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_seat_cap_matches_plan
  CHECK (
    -- 1 PAID seat. The free bookkeeper seat is exempt from the cap in
    -- app.enforce_seat_cap(), so the spouse still gets her own login.
    (plan = 'light' AND seat_cap = 1)  OR
    -- ⛔ 2, not 1. The second seat is the owner's spouse doing the books, and
    -- charging a crew price the moment she gets a login prices out the exact
    -- household this tier exists to protect (Cory 2026-08-13).
    (plan = 'solo'  AND seat_cap = 2)  OR
    (plan = 'crew'  AND seat_cap = 10) OR
    (plan = 'shop'  AND seat_cap = 25)
  );

-- ── proof ────────────────────────────────────────────────────────────────
-- ⛔ Asserts BEHAVIOUR, not the existence of DDL, and does it with UPDATE
-- rather than INSERT: `subscriptions` is one-row-per-tenant, so an INSERT
-- probe trips uniqueness first and "passes" without ever reaching the CHECK
-- it claims to test (the 0057 lesson).
-- ⛔ An empty table means this migration was verified by NOBODY, and it must
-- say so out loud rather than reporting a silent success — a probe whose
-- early-return looks identical to a pass is how 0059 passed on dev and failed
-- on prod.
DO $$
DECLARE
  probe_tenant uuid;
  ok_light     boolean := false;
  rejected_cap boolean := false;
  rejected_key boolean := false;
BEGIN
  SELECT tenant_id INTO probe_tenant FROM subscriptions LIMIT 1;

  IF probe_tenant IS NULL THEN
    RAISE NOTICE '⚠ 0061 NOT EXERCISED: subscriptions is empty, the widened CHECKs verified nothing here. Re-run against an environment that has rows.';
    RETURN;
  END IF;

  -- 1. light + 1 seat is now accepted
  BEGIN
    UPDATE subscriptions SET plan = 'light', seat_cap = 1 WHERE tenant_id = probe_tenant;
    ok_light := true;
    RAISE EXCEPTION 'probe rollback';
  EXCEPTION
    WHEN raise_exception THEN NULL;
    WHEN check_violation THEN ok_light := false;
  END;

  -- 2. light with a crew-sized cap is still refused
  BEGIN
    UPDATE subscriptions SET plan = 'light', seat_cap = 10 WHERE tenant_id = probe_tenant;
    rejected_cap := false;
    RAISE EXCEPTION 'probe rollback';
  EXCEPTION
    WHEN raise_exception THEN NULL;
    WHEN check_violation THEN rejected_cap := true;
  END;

  -- 3. an invented plan key is still refused
  BEGIN
    UPDATE subscriptions SET plan = 'starter', seat_cap = 1 WHERE tenant_id = probe_tenant;
    rejected_key := false;
    RAISE EXCEPTION 'probe rollback';
  EXCEPTION
    WHEN raise_exception THEN NULL;
    WHEN check_violation THEN rejected_key := true;
  END;

  IF NOT ok_light THEN
    RAISE EXCEPTION '0061 FAILED: plan=light seat_cap=1 was rejected';
  END IF;
  IF NOT rejected_cap THEN
    RAISE EXCEPTION '0061 FAILED: plan=light seat_cap=10 was ACCEPTED — the cap is not welded to the plan';
  END IF;
  IF NOT rejected_key THEN
    RAISE EXCEPTION '0061 FAILED: an unknown plan key was ACCEPTED';
  END IF;

  RAISE NOTICE '0061 verified on a real row: light/1 accepted, light/10 refused, unknown key refused';
END $$;
