import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { listBankTxns } from "@/modules/bank-rec";
import {
  checkBudget,
  finishRun,
  propose,
  retrieveCases,
  startRun, type AgentActorScope } from "@/modules/agents";
import { buildQuestionCard, type CardContext } from "./cards";

// The Financial agent's run loop: scan the For-Review queue, build one
// deterministic question card per item, and push each through the action
// gate. bank.categorize is ALWAYS_HITL, so every card waits for a human in
// every mode — the agent does the paperwork, the human keeps the pen.

export interface FinancialRunReport {
  runId: string;
  scanned: number;
  proposed: number;
  duplicates: number;
}

export async function runFinancialAgent(
  scope: AgentActorScope,
  limit = 25,
): Promise<FinancialRunReport> {
  await checkBudget(scope);
  const runId = await startRun(scope, "financials", "manual");

  const [txns, ctx, openTxnIds] = await Promise.all([
    listBankTxns(scope, "pending"),
    loadContext(scope),
    withTenant(scope, async (c) => {
      // One open card per transaction: a changed context must not stack a
      // second question on a txn the human hasn't answered yet.
      const { rows } = await c.query<{ txn_id: string }>(
        `SELECT payload->>'txnId' AS txn_id FROM agent_actions
          WHERE kind = 'bank.categorize' AND status = 'proposed'`,
      );
      return new Set(rows.map((r) => r.txn_id));
    }),
  ]);

  let proposed = 0;
  let duplicates = 0;
  const batch = txns.slice(0, limit).filter((t) => !openTxnIds.has(t.id));
  for (const t of batch) {
    const card = buildQuestionCard(
      {
        id: t.id,
        description: t.description,
        amountCents: t.amountCents,
        postedOn: t.postedOn,
        personalSuspect: t.personalSuspect,
        suggestion: t.suggestion
          ? { action: t.suggestion.action, accountCode: t.suggestion.accountCode }
          : null,
      },
      ctx,
    );
    const r = await propose(scope, {
      agentKey: "financials",
      kind: card.kind,
      payload: card.payload,
      figures: card.figures,
      idempotencyKey: card.idempotencyKey,
      confidence: card.confidence,
      runId,
    });
    if (r.duplicate) duplicates++;
    else proposed++;
  }

  await finishRun(scope, runId, {
    ok: true,
    output: { scanned: batch.length, proposed, duplicates },
    costMicroUsd: 0, // fully deterministic run — no model tokens spent
  });
  return { runId, scanned: batch.length, proposed, duplicates };
}

async function loadContext(scope: TenantScope): Promise<CardContext> {
  const jobs = await withTenant(scope, async (c) => {
    // Completed-but-not-closed jobs still take costs — supplier invoices
    // trail in after the crew leaves. Only 'closed' stops costing.
    const { rows } = await c.query<{ id: string; job_no: number; name: string }>(
      `SELECT id, job_no, name FROM jobs
        WHERE status <> 'closed'
        ORDER BY created_at DESC LIMIT 20`,
    );
    return rows.map((r) => ({ id: r.id, jobNo: Number(r.job_no), name: r.name }));
  });

  // Learning retrieval: the account the human last confirmed for an
  // unmatched expense becomes the next default suggestion.
  const cases = await retrieveCases(scope, "financials", 20);
  let lastExpenseAccount: string | null = null;
  for (const cs of cases) {
    if (cs.decision !== "accepted" && cs.decision !== "edited") continue;
    const p = { ...cs.proposal, ...(cs.edit ?? {}) } as { action?: string; accountCode?: string };
    if (p.action === "expense" && p.accountCode) {
      lastExpenseAccount = p.accountCode;
      break;
    }
  }
  // The shop's own first cost code. Null is a real answer — see CardContext.
  const defaultCostCode = await withTenant(scope, async (c) => {
    const { rows } = await c.query<{ code: string }>(
      "SELECT code FROM cost_codes WHERE is_active ORDER BY sort_order, code LIMIT 1",
    );
    return rows[0]?.code ?? null;
  });

  return { jobs, lastExpenseAccount, defaultCostCode };
}
