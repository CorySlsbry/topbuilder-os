import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { costMicroUsd, ratesFromEnv } from "./token-cost";

/**
 * THE ONE WRITER of `assist_usage`.
 *
 * ⛔ WHY IT IS ONE. Every direct model call has to record what it spent, and
 * `checkBudget` sums that column. Three hand-rolled INSERTs (polish, voicemail
 * draft, books-qa) is three chances to forget the cost — and forgetting it is
 * silent, because a missing cost reads as a legal 0 and the cap simply never
 * trips. That is exactly how this broke the first time. A structural test
 * asserts this file is the only one containing `INSERT INTO assist_usage`.
 *
 * ⛔ COSTING HAPPENS HERE, not at the call sites, so no caller can record
 * tokens without also recording money.
 *
 * ⛔ NEVER THROWS. Bookkeeping about the helper must not break the helper — a
 * failed usage write is logged and swallowed. The honest consequence: a shop
 * whose usage table is unwritable gets an under-counted meter rather than a
 * dead feature. That trade is deliberate; the alternative is a 500 on a
 * successful answer.
 */
export interface AssistUsageRow {
  /** Free-text tag: `polish:estimate`, `draft:voicemail`, `books-qa`. No CHECK. */
  kind: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** 'ok' | 'figure_violation' | 'error' — what became of the model's output. */
  outcome: string;
  detail?: string;
}

export async function recordAssistUsage(
  scope: TenantScope,
  row: AssistUsageRow,
): Promise<number> {
  const cost = costMicroUsd(
    row.model ?? "",
    row.inputTokens ?? 0,
    row.outputTokens ?? 0,
    ratesFromEnv(process.env.AGENT_MODEL_RATES),
  );
  await withTenant(scope, async (c) => {
    await c.query(
      `INSERT INTO assist_usage
         (tenant_id, uid, kind, model, input_tokens, output_tokens, outcome, detail, cost_microusd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        scope.tenantId,
        scope.uid,
        row.kind,
        row.model ?? "",
        Math.max(0, Math.trunc(row.inputTokens ?? 0)),
        Math.max(0, Math.trunc(row.outputTokens ?? 0)),
        row.outcome,
        (row.detail ?? "").slice(0, 200),
        cost,
      ],
    );
  }).catch((err) => {
    // Loud in the logs, invisible to the user. An under-counted meter is a
    // known, bounded failure; a broken answer is not.
    console.error("[assist-usage] write failed (%s): %s", row.kind, (err as Error).message);
  });
  return cost;
}
