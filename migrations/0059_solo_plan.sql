-- 0059 — a third plan, so a one-person shop is not asked to pay a crew price.
--
-- Pricing moves from two tiers to three (Cory 2026-08-13):
--
--   Solo   $349/mo   just the owner, 1 seat    os_solo_349   [NEW]
--   Crew   $499/mo   up to 10 people           os_crew_499   (was $349)
--   Shop   $999/mo   up to 25 people           os_shop_999   (was $499)
--
-- All three prices are already live in Stripe, in both test and live mode, with
-- the retired prices archived and each product's default_price repointed.
--
-- Why Solo exists, in the owner's words: "if it is just them we can do the $349,
-- if more users are using the app we need to charge more. I want to make sure
-- the solo guy is taken care of." Without this rung a single-truck operator was
-- being asked for $499, against roughly $245-500 for the field software alone.
--
-- ⛔ THE CONSTRAINT IS DROPPED BY CATALOG LOOKUP, NOT BY GUESSED NAME.
-- `subscriptions.plan` was declared inline in 0023, so Postgres generated its
-- constraint name. Hardcoding a guess ("subscriptions_plan_check") is how a
-- migration passes locally and fails in production against a database whose
-- constraint was created under a different name. Migration 0050 learned this on
-- cost_entries; the rule is now: find it in pg_constraint, drop what you found.

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
     AND pg_get_constraintdef(c.oid) ILIKE '%crew%'
   LIMIT 1;

  IF conname_found IS NULL THEN
    RAISE NOTICE 'no plan CHECK found on subscriptions; nothing to widen';
  ELSE
    EXECUTE format('ALTER TABLE subscriptions DROP CONSTRAINT %I', conname_found);
    RAISE NOTICE 'dropped % on subscriptions', conname_found;
  END IF;
END $$;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_check CHECK (plan IN ('solo', 'crew', 'shop'));

-- ── seat_cap sanity ──────────────────────────────────────────────────────
-- Nothing enforced that seat_cap matched the plan, which is how a row can end
-- up on Solo with ten seats and quietly sell nine seats for nothing. The plan
-- is the source of truth for the cap, so tie them together.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_seat_cap_matches_plan;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_seat_cap_matches_plan
  CHECK (
    -- ⛔ 2, not 1. The second seat is the owner's spouse doing the books, and
    -- charging a crew price the moment she gets a login prices out the exact
    -- household this tier exists to protect (Cory 2026-08-13).
    (plan = 'solo' AND seat_cap = 2)  OR
    (plan = 'crew' AND seat_cap = 10) OR
    (plan = 'shop' AND seat_cap = 25)
  );

-- ── proof ────────────────────────────────────────────────────────────────
-- ⛔ Asserts BEHAVIOUR, not the existence of DDL. 0054 shipped a probe that
-- only checked a CHECK had landed while its INSERT had silently affected zero
-- rows (see 0057). So: prove 'solo' is now accepted and that garbage still is
-- not, using a transaction that rolls itself back.
-- ⛔ EXERCISED WITH UPDATE, NOT INSERT. `subscriptions` is one-row-per-tenant,
-- so an INSERT probe would trip the uniqueness constraint and Postgres does not
-- guarantee which constraint reports first. The probe would then "pass" without
-- the CHECK ever having been evaluated, which is precisely the vacuous-pass
-- failure 0054 shipped. An UPDATE on an existing row reaches the CHECK and
-- nothing else.
--
-- Every write below is rolled back by its own exception block (PL/pgSQL opens
-- an implicit savepoint per BEGIN...EXCEPTION), so this probe leaves no trace.
-- Variable assignments survive that rollback; row changes do not.
DO $$
DECLARE
  t_id      uuid;
  has_row   boolean;
  ok_solo   boolean := false;
  rejected  boolean := false;
BEGIN
  SELECT id INTO t_id FROM tenants ORDER BY created_at LIMIT 1;
  IF t_id IS NULL THEN
    RAISE NOTICE 'no tenants yet; constraint widened but not exercised';
    RETURN;
  END IF;
  PERFORM set_config('app.current_tenant', t_id::text, true);
  SELECT EXISTS (SELECT 1 FROM subscriptions) INTO has_row;

  IF NOT has_row THEN
    RAISE NOTICE 'tenant % has no subscription row; constraint widened but not exercised', t_id;
    RETURN;
  END IF;

  -- 'solo' with its matching seat cap must now be ACCEPTED.
  -- ⛔ 2, matching the constraint above. This probe was written when the cap
  -- was 1 and it FAILED THE PRODUCTION MIGRATION when the cap moved to 2,
  -- which is the probe doing its job. Dev passed the same migration only
  -- because dev has no subscription rows, so the probe returned early without
  -- exercising anything. That is the vacuous pass this file's own header warns
  -- about, and it is why the early-return path RAISEs a NOTICE saying the
  -- constraint was widened but NOT exercised.
  BEGIN
    UPDATE subscriptions SET plan = 'solo', seat_cap = 2;
    ok_solo := true;
    RAISE EXCEPTION 'PROBE_ROLLBACK';
  EXCEPTION
    WHEN check_violation THEN
      RAISE EXCEPTION 'the solo plan is STILL rejected by a CHECK constraint';
    WHEN OTHERS THEN
      IF SQLERRM <> 'PROBE_ROLLBACK' THEN RAISE; END IF;
  END;
  IF NOT ok_solo THEN
    RAISE EXCEPTION 'the solo UPDATE never completed; the probe proved nothing';
  END IF;

  -- A bogus plan must still be REJECTED, or the constraint is not binding.
  BEGIN
    UPDATE subscriptions SET plan = 'enterprise', seat_cap = 99;
    RAISE EXCEPTION 'PROBE_ROLLBACK';
  EXCEPTION
    WHEN check_violation THEN rejected := true;
    WHEN OTHERS THEN
      IF SQLERRM <> 'PROBE_ROLLBACK' THEN RAISE; END IF;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'a bogus plan was accepted; the CHECK is not binding';
  END IF;

  -- And a plan whose seat cap does not match it must be rejected too. 10 is
  -- the CREW cap, so this is the exact mistake that would sell eight seats for
  -- nothing if the constraint were not binding.
  rejected := false;
  BEGIN
    UPDATE subscriptions SET plan = 'solo', seat_cap = 10;
    RAISE EXCEPTION 'PROBE_ROLLBACK';
  EXCEPTION
    WHEN check_violation THEN rejected := true;
    WHEN OTHERS THEN
      IF SQLERRM <> 'PROBE_ROLLBACK' THEN RAISE; END IF;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'solo with 10 seats was accepted; seat_cap is not tied to the plan';
  END IF;

  RAISE NOTICE 'solo accepted, bogus plan rejected, mismatched seat cap rejected';
END $$;
