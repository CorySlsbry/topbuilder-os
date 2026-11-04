-- 0062 — give `assist_usage` a COST, so the spend cap has a meter to read.
--
-- ⛔ THE BUG THIS CLOSES. `checkBudget()` sums `agent_daily_costs` and refuses
-- to start billable work when the day's total passes the cap. That table is
-- written only by `finishRun(..., costMicroUsd)` — and EVERY production agent
-- passes 0, because they are deterministic and genuinely free. Meanwhile the
-- paths that actually spend money (polish, voicemail drafts, and above all
-- `books-qa`, a six-turn loop that re-sends every tool result) recorded their
-- tokens in `assist_usage`, a table `checkBudget` never looked at — and
-- `books-qa` recorded nothing at all. The cap was wired, was called on every
-- question, and was arithmetically incapable of tripping.
--
-- ⛔ WHY A COLUMN AND NOT A CONVERSION AT READ TIME. The rate is approximate
-- and will be corrected (see token-cost.ts). Stamping the cost at write time
-- freezes the rate that was in force for that call, so a later price fix does
-- not silently rewrite last month's history — and the cap does not have to
-- carry a pricing table into SQL.
--
-- ⛔ OWNERSHIP, so nothing is counted twice: a model call is recorded in
-- `assist_usage` and NOWHERE else; an agent-run cost is recorded in
-- `agent_daily_costs` and nowhere else. `checkBudget` sums both. A structural
-- test asserts books-qa does not also pass costMicroUsd to finishRun.

ALTER TABLE assist_usage
  ADD COLUMN IF NOT EXISTS cost_microusd bigint NOT NULL DEFAULT 0;

-- The cap reads "this tenant, today". Without this the daily sum degrades to a
-- scan of every assist call the shop has ever made, on the hot path of every
-- question asked.
CREATE INDEX IF NOT EXISTS assist_usage_tenant_day_idx
  ON assist_usage (tenant_id, created_at DESC);

COMMENT ON COLUMN assist_usage.cost_microusd IS
  'Approximate cost in micro-USD at the rate in force when the call was made. A SAFETY RAIL for the daily cap, never an invoice. See src/modules/agents/internal/token-cost.ts.';

-- ── proof ────────────────────────────────────────────────────────────────
-- ⛔ Asserts BEHAVIOUR, not that the DDL ran: that the column accepts a real
-- cost, that it defaults to 0 for the historical rows written before today,
-- and that the daily-sum query the cap will run actually returns that cost.
-- ⛔ If there is nothing to exercise it against, it says so OUT LOUD rather
-- than returning a silence that looks identical to a pass (the 0059 lesson,
-- re-learned on 0061 which verified nothing in either environment).
DO $$
DECLARE
  probe_tenant uuid;
  probe_id     uuid;
  summed       bigint;
  defaulted    bigint;
BEGIN
  SELECT id INTO probe_tenant FROM tenants LIMIT 1;

  IF probe_tenant IS NULL THEN
    RAISE NOTICE '⚠ 0062 NOT EXERCISED: no tenants exist, so the cost column and the daily-sum query verified nothing here. Re-run against an environment with rows.';
    RETURN;
  END IF;

  -- ⛔ SET THE TENANT GUC BEFORE WRITING. `assist_usage` is FORCE ROW LEVEL
  -- SECURITY, and on Cloud SQL the `postgres` role is NOT a true superuser, so
  -- it does NOT bypass FORCE — the INSERT below hits the policy's WITH CHECK
  -- with `app.current_tenant` unset and is rejected. This migration failed in
  -- production for exactly that reason on 2026-08-15 while passing on a local
  -- Postgres where `postgres` IS superuser and RLS is skipped. Third time this
  -- codebase has been bitten by that difference (0034, 0037, now 0062): a
  -- migration probe that touches a FORCE-RLS table must set the GUC itself.
  PERFORM set_config('app.current_tenant', probe_tenant::text, true);

  BEGIN
    INSERT INTO assist_usage (tenant_id, uid, kind, model, input_tokens, output_tokens, cost_microusd)
      VALUES (probe_tenant, 'probe:0062', 'probe', 'claude-haiku-4-5', 1000, 200, 2000)
      RETURNING id INTO probe_id;

    -- the exact shape checkBudget will run
    SELECT COALESCE(SUM(cost_microusd), 0) INTO summed
      FROM assist_usage
     WHERE tenant_id = probe_tenant
       AND created_at >= CURRENT_DATE;

    -- a row written WITHOUT a cost must read 0, not NULL: the cap sums this
    -- column, and one NULL would turn the whole SUM into NULL.
    INSERT INTO assist_usage (tenant_id, uid, kind, model, input_tokens, output_tokens)
      VALUES (probe_tenant, 'probe:0062', 'probe', 'claude-haiku-4-5', 5, 5);
    SELECT cost_microusd INTO defaulted
      FROM assist_usage WHERE uid = 'probe:0062' AND cost_microusd = 0 LIMIT 1;

    IF summed < 2000 THEN
      RAISE EXCEPTION '0062 FAILED: the daily-sum query returned % — it cannot see the cost it just wrote', summed;
    END IF;
    IF defaulted IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION '0062 FAILED: a row written without a cost read % instead of 0', defaulted;
    END IF;

    RAISE EXCEPTION 'probe rollback';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'probe rollback' THEN RAISE; END IF;
  END;

  RAISE NOTICE '0062 verified on a real tenant: cost stored, daily sum sees it, missing cost defaults to 0 (not NULL)';
END $$;
