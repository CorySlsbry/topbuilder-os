import "server-only";
import { checkBudget, finishRun, propose, startRun, type AgentActorScope } from "@/modules/agents";
import { withTenant } from "@/lib/db/tenant";
import { listTargets } from "./targets";
import { outreachDraft } from "./outreach";

// The Sales agent (deterministic): one outreach draft per top target, from
// the signals engine's own facts. ALWAYS_HITL — a message to a customer
// never leaves without the owner's yes, and approving is what sends it
// (and snoozes the signal, so the list stops nagging about a call that is
// already in flight).

export interface SalesRunReport {
  runId: string;
  proposed: number;
  duplicates: number;
}

/** Enough to fill an approvals session, not enough to feel like a queue. */
const TOP_N = 5;

export async function runSalesAgent(scope: AgentActorScope): Promise<SalesRunReport> {
  await checkBudget(scope);
  const runId = await startRun(scope, "sales", "manual");

  const targets = await listTargets(scope);
  const { biz, recentlyDrafted } = await withTenant(scope, async (c) => {
    // The draft SIGNS with the business name, so it has to resolve at
    // propose time. The member-read policy on tenants returns nothing for
    // the cron's machine principal (not a member) — the first live run
    // signed five drafts "your service team". The cron directory definer
    // already exists for exactly this caller; same exposure, real name.
    const t = await c.query<{ name: string }>(
      `SELECT name FROM tenants WHERE id = $1
       UNION ALL
       SELECT name FROM app.cron_tenants() WHERE id = $1
       LIMIT 1`,
      [scope.tenantId],
    );
    // One conversation per customer at a time: any sales card from the last
    // 30 days — pending, sent, or declined — means the shop already has a
    // stance on this household, and drafting their SECOND-heaviest signal
    // the very next morning would be spam with an approval step.
    const recent = await c.query<{ customer_id: string }>(
      `SELECT DISTINCT payload->>'customerId' AS customer_id
         FROM agent_actions
        WHERE kind = 'sales.outreachDraft'
          AND created_at > now() - interval '30 days'`,
    );
    return {
      biz: t.rows[0]?.name ?? "your service team",
      recentlyDrafted: new Set(recent.rows.map((r) => r.customer_id)),
    };
  });

  let proposed = 0;
  let duplicates = 0;
  for (const target of targets.slice(0, TOP_N)) {
    if (recentlyDrafted.has(target.customerId)) continue;
    const draft = outreachDraft(target, biz);
    if (!draft) continue;
    const r = await propose(scope, {
      agentKey: "sales",
      kind: "sales.outreachDraft",
      payload: {
        customerId: target.customerId,
        customerName: target.name,
        signalKey: draft.signalKey,
        reason: draft.reason,
        message: draft.message,
      },
      figures: draft.figures,
      // Frozen for the month, then rolls on purpose: agent_actions dedupes
      // on this key FOREVER, and half the signal keys name recurring states
      // (a membership can lapse again next year). Customer + month gives
      // at most one card per household per month; the 30-day cooldown above
      // covers the month boundary, and dispositions govern anything longer.
      idempotencyKey: `outreach:${target.customerId}:${new Date().toISOString().slice(0, 7)}`,
      confidence: 80,
      runId,
    });
    if (r.duplicate) duplicates++;
    else proposed++;
  }

  await finishRun(scope, runId, {
    ok: true,
    output: { proposed, duplicates },
    costMicroUsd: 0,
  });
  return { runId, proposed, duplicates };
}
