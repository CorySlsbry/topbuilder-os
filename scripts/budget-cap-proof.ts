/**
 * budget-cap-proof — make the daily spend cap FIRE against a real database, and
 * prove it fires because of `assist_usage` specifically.
 *
 * ⛔ WHY THIS SCRIPT EXISTS. A cap that has never been observed to trip is
 * indistinguishable from no cap. This one was wired, was called on every
 * question, and was arithmetically incapable of stopping anything: it summed
 * `agent_daily_costs`, which only agent runs write and which every production
 * agent writes as 0, while the actual model spend went to `assist_usage` (or,
 * for books-qa, nowhere at all). Unit tests prove the arithmetic; only this
 * proves the wiring.
 *
 * It asserts BOTH directions, because a gate that only ever says "no" is as
 * useless as one that only ever says "yes":
 *   1. under the cap  -> checkBudget resolves
 *   2. over  the cap  -> checkBudget throws agent_budget_exceeded:tenant_daily
 *   3. and the ONLY thing that changed between 1 and 2 was assist_usage rows
 *
 * Everything it writes is rolled back.
 *
 * Run:  DATABASE_URL=postgres://...@localhost:5432/topbuilder \
 *       npx tsx --conditions=react-server scripts/budget-cap-proof.ts <tenant-slug>
 */
import { getPool } from "../src/lib/db/pool";
import { checkBudget, costMicroUsd, getDailyCost } from "../src/modules/agents";

const CAP_USD = Number(process.env.AGENT_DAILY_USD_CAP ?? 5);
const CAP_MICRO = CAP_USD * 1_000_000;

/**
 * Delete this script's own rows as the migration owner.
 *
 * Checked BEFORE anything is written (see main), never only at cleanup time: a
 * proof that cannot tidy up after itself must refuse to start, not discover it
 * halfway through and leave the meter permanently inflated for the day.
 */
async function cleanupAsOwner(marker: string): Promise<number> {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
  await c.connect();
  try {
    const r = await c.query(`DELETE FROM assist_usage WHERE uid = $1`, [marker]);
    return r.rowCount ?? 0;
  } finally {
    await c.end();
  }
}

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug) throw new Error("usage: budget-cap-proof.ts <tenant-slug>");
  // ⛔ Refuse to start if the cleanup path is unavailable. This script commits
  // real rows on purpose (see below); without an owner DSN it would inflate the
  // tenant's meter for the rest of the day and have no way to undo it.
  if (!process.env.MIGRATE_DATABASE_URL) {
    throw new Error("set MIGRATE_DATABASE_URL — this proof commits rows and must be able to delete them");
  }

  const pool = getPool();
  const t = await pool.query<{ id: string | null }>("SELECT app.tenant_id_by_slug($1) AS id", [slug]);
  const tenantId = t.rows[0]?.id;
  if (!tenantId) throw new Error(`no tenant '${slug}'`);
  const scope = { uid: "proof:budget", tenantId };

  console.log(`tenant ${slug} (${tenantId})`);
  console.log(`cap: $${CAP_USD}/day = ${CAP_MICRO} microUSD\n`);

  // ── 1. baseline: the cap must NOT be tripped before we spend anything ────
  const before = await getDailyCost(scope);
  console.log(`spent today (before): ${before.todayMicroUsd} microUSD`);
  if (before.todayMicroUsd >= CAP_MICRO) {
    throw new Error(
      `this tenant has ALREADY spent its cap today (${before.todayMicroUsd}); ` +
        `the proof cannot distinguish its own writes from real ones. Re-run tomorrow or on a scratch tenant.`,
    );
  }
  try {
    await checkBudget(scope);
    console.log("  ✓ under the cap -> checkBudget allowed the work");
  } catch (e) {
    throw new Error(`checkBudget refused BELOW the cap: ${(e as Error).message}`);
  }

  // ── 2. spend past the cap, using ONLY assist_usage ───────────────────────
  // The table the cap could not see before. If the cap still does not trip,
  // the fix did not land.
  const model = "claude-haiku-4-5-20251001";
  const perCall = costMicroUsd(model, 200_000, 40_000); // ~$0.40 of Haiku
  const needed = CAP_MICRO - before.todayMicroUsd;
  const calls = Math.ceil(needed / perCall);
  console.log(`\nwriting ${calls} assist_usage row(s) at ${perCall} microUSD each…`);

  /**
   * ⛔ THE ROWS ARE COMMITTED, ON PURPOSE.
   *
   * The obvious version of this script writes inside a transaction and rolls
   * back — and proves nothing, because `checkBudget` opens its OWN connection
   * and cannot see uncommitted rows. It would have to check the sum itself,
   * which means the thing under test is never actually run: the proof would
   * confirm arithmetic it did itself while `checkBudget` stayed unobserved.
   * That is the failure mode this whole task exists to fix, so instead the
   * rows are committed, the REAL function is called, and the marked rows are
   * deleted in a `finally` that runs on every path.
   */
  const MARKER = "proof:budget";
  let threw: string | null = null;
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('app.current_tenant', $1, false)", [tenantId]);
      for (let i = 0; i < calls; i++) {
        await client.query(
          `INSERT INTO assist_usage
             (tenant_id, uid, kind, model, input_tokens, output_tokens, outcome, detail, cost_microusd)
           VALUES ($1,$2,'books-qa',$3,200000,40000,'ok','budget-cap-proof',$4)`,
          [tenantId, MARKER, model, perCall],
        );
      }
    } finally {
      client.release();
    }

    const after = await getDailyCost(scope);
    console.log(`spent today (after):  ${after.todayMicroUsd} microUSD`);
    if (after.todayMicroUsd < CAP_MICRO) {
      throw new Error(
        `the meter reads ${after.todayMicroUsd}, below the ${CAP_MICRO} cap — ` +
          `assist_usage is still invisible to getDailyCost`,
      );
    }

    // ⛔ THE ASSERTION. The real function, on its own connection, against
    // committed rows written by nothing but assist_usage.
    try {
      await checkBudget(scope);
    } catch (e) {
      threw = (e as Error).message;
    }
  } finally {
    /**
     * ⛔ CLEANUP RUNS AS THE MIGRATION OWNER, because the app role has INSERT
     * and SELECT on `assist_usage` but NOT DELETE — a usage log is append-only
     * to the application, which is correct and was discovered by this script
     * stranding 13 rows on its first run. The marker makes the delete surgical:
     * it can only remove rows this script wrote.
     */
    const del = await cleanupAsOwner(MARKER);
    console.log(`\ncleaned up ${del} proof row(s).`);
  }

  if (!threw) {
    throw new Error("checkBudget did NOT throw over the cap — the cap does not fire");
  }
  if (!threw.includes("agent_budget_exceeded")) {
    throw new Error(`checkBudget threw the WRONG error: ${threw}`);
  }
  console.log(`  ✓ over the cap -> checkBudget threw: ${threw}`);

  // ── 3. and it lets go again once the spend is gone ───────────────────────
  // Proves the refusal came from the rows, not from a permanently-stuck gate.
  const restored = await getDailyCost(scope);
  if (restored.todayMicroUsd !== before.todayMicroUsd) {
    throw new Error(`cleanup did not restore the meter (${restored.todayMicroUsd} vs ${before.todayMicroUsd})`);
  }
  await checkBudget(scope);
  console.log("  ✓ spend removed -> checkBudget allows again\n");
  console.log("PROVED: the cap reads assist_usage, and it fires.");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
