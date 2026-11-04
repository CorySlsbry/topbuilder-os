-- ⛔ A TABLE USED TO RESOLVE TENANCY CANNOT BE FORCE-SCOPED BY TENANCY.
--
-- This migration fixes three live outages that share one cause, and installs a
-- guard so the cause cannot come back.
--
-- ── The mechanism ─────────────────────────────────────────────────────────
-- `SECURITY DEFINER` runs a function as its OWNER. `FORCE ROW LEVEL SECURITY`
-- is precisely the setting that makes RLS policies bind the owner too. So a
-- definer function reading a FORCE table matches its policy like anyone else —
-- and every one of these functions exists to answer a question asked BEFORE a
-- session exists, when `app.current_tenant` is by definition unset. The policy
-- evaluates against NULL, matches nothing, and the function returns NULL.
--
-- Not an error. Not a log line. Just NULL, which every caller then handles
-- politely as "not found".
--
-- ── Verified, not assumed (2026-08-11, against production) ────────────────
--   * `postgres` on this Cloud SQL instance is rolsuper=false, rolbypassrls=false,
--     so FORCE genuinely binds it. (On a self-hosted box with a true superuser
--     none of this reproduces — which is exactly why it survived local testing.)
--   * A throwaway portal token was minted inside a transaction and the definer
--     function called with the scope cleared, exactly as a real request has it:
--       visible WITH tenant scope : 1
--       app.portal_context() NO scope : 0 rows
--     The transaction was rolled back; nothing was written.
--
-- ── What was broken ───────────────────────────────────────────────────────
--   app.portal_context()          -> portal_tokens    THE CUSTOMER PORTAL.
--       Every portal link 404s. No customer has ever approved an estimate or
--       paid an invoice from one. Nobody noticed because the endpoint sweep
--       EXEMPTs all portal routes ("needs a minted portal token") and no real
--       customer has been sent a link yet.
--   app.redeem_advisor_invite()   -> advisor_invites  THE CPA CHANNEL.
--       An invite code can never be redeemed; the CPA cannot join.
--   app.tenant_by_stripe_customer() -> subscriptions  BILLING WEBHOOKS.
--       Stripe's payload tenant ids are deliberately not trusted, so this
--       lookup IS the tenant resolution. Returning NULL means a subscription
--       event silently updates nothing — a customer could pay and never be
--       upgraded. No subscription carries a stripe_customer_id yet, so this
--       one is caught BEFORE it ever cost anybody money.
--
-- ── Why dropping FORCE costs nothing ──────────────────────────────────────
-- This is the part worth being sure about before shipping it.
--
-- The application connects as `app_user`, which is NOT the owner of these
-- tables. RLS applies to a non-owner whether or not FORCE is set. FORCE
-- changes the behaviour of exactly one role — the owner, `postgres` — which is
-- the role migrations and definer functions run as, and which is not reachable
-- from the application at all.
--
-- So: the tenant boundary for every real request is UNCHANGED. The policies
-- stay. ENABLE stays. This is the same posture `tenants` and `memberships`
-- have carried since migration 0001 for the same documented reason, and that
-- `tenant_sms_numbers` was given deliberately in 0040 after this exact bug ate
-- every inbound text.
--
-- The rule, stated so the next person does not have to re-derive it:
--   A table on the path from an unauthenticated fact (a slug, a phone number,
--   a token, a Stripe customer id) to a tenant_id is a DIRECTORY table.
--   ENABLE, policy, GRANT — never FORCE.

ALTER TABLE portal_tokens   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE advisor_invites NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions   NO FORCE ROW LEVEL SECURITY;

-- ── The same law, a different shape: app.lir_cohorts() ───────────────────
-- Found by the structural test written alongside this migration, which is the
-- only reason anyone looked.
--
-- `lir_cohorts` is the platform-operator retention chart. It reads `jobs`,
-- `appointments`, `cost_entries`, `invoices`, `payments` and `reconciliations`
-- ACROSS ALL TENANTS from a single unscoped query — and every one of those is
-- FORCE by design, because they are the money tables the entire isolation
-- story rests on. So the chart has always returned an empty result.
--
-- The fix is NOT to drop FORCE on the money tables. That would be trading the
-- product's core guarantee for an admin chart. The fix is the pattern
-- `app.cron_tenants()` established in 0038: enumerate tenants, then do the
-- work ONCE PER TENANT with that tenant's scope set, so every read still runs
-- under the tenant's own policy. Slower, and correct.
CREATE OR REPLACE FUNCTION app.lir_cohorts()
RETURNS TABLE (
  cohort_month text,
  tenants bigint,
  tenants_through_loop bigint,
  loop_jobs bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $fn$
DECLARE
  t        record;
  v_n      bigint;
  v_cohort text[]   := '{}';
  v_jobs   bigint[] := '{}';
BEGIN
  -- `tenants` is ENABLE-only, so this enumeration is readable here. Everything
  -- below it is not, which is the whole point of the loop.
  FOR t IN SELECT id, created_at FROM tenants ORDER BY created_at LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    -- The LIR: jobs that went all the way through the loop — scheduled, costs
    -- captured, invoiced AND paid, on books that were reconciled — within 45
    -- days of the shop signing up.
    SELECT count(*) INTO v_n
      FROM jobs j
     WHERE EXISTS (SELECT 1 FROM appointments a
                    WHERE a.job_id = j.id
                      AND a.created_at <= t.created_at + interval '45 days')
       AND EXISTS (SELECT 1 FROM cost_entries ce
                    WHERE ce.job_id = j.id
                      AND ce.created_at <= t.created_at + interval '45 days')
       AND EXISTS (SELECT 1 FROM invoices i
                    JOIN payments p ON p.invoice_id = i.id
                    WHERE i.job_id = j.id
                      AND p.created_at <= t.created_at + interval '45 days')
       AND EXISTS (SELECT 1 FROM reconciliations r
                    WHERE r.created_at <= t.created_at + interval '45 days');

    v_cohort := v_cohort || to_char(t.created_at, 'YYYY-MM');
    v_jobs   := v_jobs   || v_n;
  END LOOP;

  -- Leave no scope behind for whatever runs next on this connection.
  PERFORM set_config('app.current_tenant', '', true);

  RETURN QUERY
    SELECT u.c,
           count(*)::bigint,
           count(*) FILTER (WHERE u.j >= 3)::bigint,
           COALESCE(sum(u.j), 0)::bigint
      FROM unnest(v_cohort, v_jobs) AS u(c, j)
     GROUP BY u.c
     ORDER BY u.c;
END $fn$;
REVOKE ALL ON FUNCTION app.lir_cohorts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lir_cohorts() TO app_user;

COMMENT ON FUNCTION app.lir_cohorts() IS
  'Platform retention cohorts. Loops tenants and sets app.current_tenant per '
  'tenant (the app.cron_tenants pattern) because the money tables it reads are '
  'FORCE RLS and must stay that way. See migration 0041.';

-- ── The guard ─────────────────────────────────────────────────────────────
-- Refuse to finish if the end state is not what this migration claims. The
-- same shape as the verification block in scripts/bootstrap-prod-db.sql: a
-- migration that reports success on a database it did not actually change is
-- worse than one that fails.
DO $$
DECLARE
  r record;
  v_bad text := '';
BEGIN
  FOR r IN
    SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('tenants','memberships','portal_tokens','advisor_invites',
                         'subscriptions','tenant_sms_numbers')
  LOOP
    -- ENABLE must stay on: it is what scopes the APPLICATION role.
    IF NOT r.enabled THEN
      v_bad := v_bad || format('%s has RLS disabled entirely; ', r.relname);
    END IF;
    -- FORCE must be off: it is what blinds the resolution functions.
    IF r.forced THEN
      v_bad := v_bad || format('%s is still FORCE; ', r.relname);
    END IF;
    -- And a policy must still exist. "Dropped FORCE" must never quietly become
    -- "dropped the boundary" — the policy is what scopes app_user, which is a
    -- non-owner and therefore bound by RLS regardless of FORCE.
    IF NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = r.relname) THEN
      v_bad := v_bad || format('%s has NO policy; ', r.relname);
    END IF;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'resolution tables in a bad state: %', v_bad;
  END IF;
  RAISE NOTICE 'resolution tables verified: RLS enabled, FORCE off, policies intact';
END $$;

COMMENT ON TABLE portal_tokens IS
  'DIRECTORY TABLE — ENABLE-only RLS, never FORCE. app.portal_context() reads '
  'it SECURITY DEFINER before any session exists; FORCE would make the policy '
  'bind the owner too and the lookup would silently return nothing. See '
  'migration 0041.';
COMMENT ON TABLE advisor_invites IS
  'DIRECTORY TABLE — ENABLE-only RLS, never FORCE. app.redeem_advisor_invite() '
  'runs before the CPA has a membership. See migration 0041.';
COMMENT ON TABLE subscriptions IS
  'DIRECTORY TABLE — ENABLE-only RLS, never FORCE. '
  'app.tenant_by_stripe_customer() resolves the tenant for a Stripe webhook, '
  'whose payload tenant ids are deliberately not trusted. See migration 0041.';
