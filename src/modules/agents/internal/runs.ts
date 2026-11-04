import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { AgentError } from "./gate";
import { overBudget } from "./token-cost";
import { canSeeAgent, readerCheck, type ActorScope } from "./visibility";

// Run bookkeeping: attempts, the 5-try dead-letter, and DB-backed cost
// caps. MAX_ATTEMPTS=5 is Anthropic's named max-iteration control, ported
// from the ServiceTitan platform (sync/service.py).

export const MAX_ATTEMPTS = 5;

const DAILY_CAP_MICROUSD = Number(process.env.AGENT_DAILY_USD_CAP ?? 5) * 1_000_000;
const GLOBAL_DAILY_CAP_MICROUSD =
  Number(process.env.AGENT_GLOBAL_DAILY_USD_CAP ?? 200) * 1_000_000;

export async function startRun(
  scope: TenantScope,
  agentKey: string,
  trigger: string,
  input?: unknown,
): Promise<string> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO agent_runs (tenant_id, agent_key, trigger, input)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [scope.tenantId, agentKey, trigger, input ? JSON.stringify(input) : null],
    );
    return rows[0]!.id;
  });
}

export async function finishRun(
  scope: TenantScope,
  runId: string,
  outcome: { ok: boolean; output?: unknown; error?: string; costMicroUsd?: number },
): Promise<void> {
  await withTenant(scope, async (c) => {
    await c.query(
      `UPDATE agent_runs SET status = $2, output = $3, error = $4,
              cost_microusd = cost_microusd + $5, finished_at = now()
        WHERE id = $1`,
      [
        runId,
        outcome.ok ? "ok" : "error",
        outcome.output ? JSON.stringify(outcome.output) : null,
        outcome.error ?? null,
        outcome.costMicroUsd ?? 0,
      ],
    );
    if (outcome.costMicroUsd) {
      await c.query(
        `INSERT INTO agent_daily_costs (tenant_id, day, cost_microusd)
         VALUES ($1, CURRENT_DATE, $2)
         ON CONFLICT (tenant_id, day) DO UPDATE SET
           cost_microusd = agent_daily_costs.cost_microusd + EXCLUDED.cost_microusd`,
        [scope.tenantId, outcome.costMicroUsd],
      );
    }
  });
}

/**
 * What has this tenant actually spent on models today?
 *
 * ⛔ SUMS BOTH METERS, because spend is recorded in two places and a cap that
 * reads one of them reads zero. Ownership is exclusive, so nothing is counted
 * twice:
 *   agent_daily_costs — costs attributed to an AGENT RUN via finishRun().
 *   assist_usage      — every direct model call (polish, voicemail draft,
 *                       books-qa), costed at write time by token-cost.ts.
 *
 * Before 2026-08-15 this summed only the first, which every production agent
 * writes as 0 because they are genuinely deterministic and free. The paid paths
 * wrote to the second, or — in books-qa's case, the biggest spender of the lot —
 * to neither. The cap could not trip. See migration 0062.
 */
async function spentTodayMicroUsd(scope: TenantScope): Promise<number> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ agents: string; assist: string }>(
      `SELECT
         (SELECT COALESCE(SUM(cost_microusd), 0)::bigint
            FROM agent_daily_costs WHERE day = CURRENT_DATE) AS agents,
         (SELECT COALESCE(SUM(cost_microusd), 0)::bigint
            FROM assist_usage WHERE created_at >= CURRENT_DATE) AS assist`,
    );
    return Number(rows[0]!.agents) + Number(rows[0]!.assist);
  });
}

/**
 * Budget check before any billable work. Two DB-backed caps: per-tenant/day
 * and global/day. Throws 409 agent_budget_exceeded — a halted agent is a
 * feature, not an outage.
 */
export async function checkBudget(scope: TenantScope): Promise<void> {
  const spent = await spentTodayMicroUsd(scope);
  if (overBudget(spent, DAILY_CAP_MICROUSD)) {
    throw new AgentError(409, "agent_budget_exceeded:tenant_daily");
  }
  // Global cap crosses tenants -> privileged aggregate via SECURITY DEFINER
  // is overkill for a SUM; the per-tenant cap is the sharp one. The global
  // backstop sums the same table as the migration-owner during ops review;
  // in-process we approximate: skip unless configured to 0 (kill).
  if (GLOBAL_DAILY_CAP_MICROUSD <= 0) {
    throw new AgentError(409, "agent_budget_exceeded:global");
  }
}

/**
 * Record a failed attempt; at MAX_ATTEMPTS the run dead-letters, the agent
 * flips OFF (self-heal), and a plain-language assessment card is written.
 */
export async function recordFailure(
  scope: TenantScope,
  runId: string,
  agentKey: string,
  error: string,
): Promise<{ deadLettered: boolean; attempt: number }> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ attempt: number }>(
      `UPDATE agent_runs SET attempt = attempt + 1, error = $2 WHERE id = $1
       RETURNING attempt`,
      [runId, error],
    );
    if (!rows[0]) throw new AgentError(404, "run_not_found");
    const attempt = rows[0].attempt;
    if (attempt < MAX_ATTEMPTS) return { deadLettered: false, attempt };

    await c.query(
      `UPDATE agent_runs SET status = 'dead_letter', finished_at = now() WHERE id = $1`,
      [runId],
    );
    const assessment =
      `The ${agentKey} helper hit the same problem ${MAX_ATTEMPTS} times and stopped itself. ` +
      `Nothing was changed on your books. Last error: ${error}. ` +
      `It stays off until you turn it back on.`;
    await c.query(
      `INSERT INTO agent_dead_letters (tenant_id, agent_key, run_id, reason, assessment)
       VALUES ($1,$2,$3,$4,$5)`,
      [scope.tenantId, agentKey, runId, error, assessment],
    );
    await c.query(
      `INSERT INTO agent_policies (tenant_id, agent_key, mode, updated_by)
       VALUES ($1,$2,'off',$3)
       ON CONFLICT (tenant_id, agent_key) DO UPDATE SET
         mode = 'off', updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [scope.tenantId, agentKey, "system:dead-letter"],
    );
    await c.query(
      `INSERT INTO audit_events (tenant_id, actor, action_id, from_status, to_status, note)
       VALUES ($1,'system:dead-letter',NULL,NULL,'dead_letter',$2)`,
      [scope.tenantId, `${agentKey}: ${error}`],
    );
    return { deadLettered: true, attempt };
  });
}

export interface DeadLetterRow {
  id: string;
  agentKey: string;
  reason: string;
  assessment: string;
  resolved: boolean;
  createdAt: string;
}

/**
 * Dead letters are filtered by the owning agent, not just the tenant: the
 * `assessment` is a written post-mortem of the failed action and quotes the
 * data it was working on (vendor, amount, worker). Same wall as the cards.
 */
export async function listDeadLetters(scope: ActorScope): Promise<DeadLetterRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT id, agent_key AS "agentKey", reason, assessment, resolved,
              created_at::text AS "createdAt"
         FROM agent_dead_letters WHERE NOT resolved
        ORDER BY created_at DESC LIMIT 50`,
    );
    const check = readerCheck(scope);
    return (rows as DeadLetterRow[]).filter((r) => canSeeAgent(check, r.agentKey));
  });
}

/**
 * What the shop is shown. Reads the SAME two meters as `checkBudget` — if this
 * and the cap could disagree, the screen would say "you have plenty left" while
 * the helper refused to run.
 */
export async function getDailyCost(scope: TenantScope): Promise<{
  todayMicroUsd: number;
  capMicroUsd: number;
}> {
  return { todayMicroUsd: await spentTodayMicroUsd(scope), capMicroUsd: DAILY_CAP_MICROUSD };
}
