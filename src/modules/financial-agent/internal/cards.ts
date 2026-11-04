// Question-card building — PURE and deterministic. The card's figures come
// verbatim from the bank transaction (authoritative); nothing here invents
// a number, and statement text is DATA — it is quoted inertly inside the
// card and is never interpreted as an instruction. (With no LLM in this
// path at all, memo prompt-injection is structurally impossible; when the
// bounded LLM helper lands, it may only pick among these same closed
// choices — never write figures.)

export interface QueueTxn {
  id: string;
  description: string;
  amountCents: number;
  postedOn: string;
  personalSuspect: boolean;
  suggestion: { action: string; accountCode: string | null } | null;
}

export interface CardContext {
  /** Active jobs, most recent first. */
  jobs: { id: string; jobNo: number; name: string }[];
  /** Account the human last confirmed for an unmatched expense (learning). */
  lastExpenseAccount: string | null;
  /**
   * The shop's own first cost code, or null when they have not set any up.
   *
   * This used to be the literal string "4100" — a NAHB homebuilder account
   * that meant nothing to a trades shop, proposed on every job-cost card the
   * bookkeeper ever approved. Null now means the agent proposes an EXPENSE
   * instead of a job cost, because the honest alternative to "I don't know
   * which code" is not "pick one for them".
   */
  defaultCostCode: string | null;
}

export interface QuestionCard {
  kind: "bank.categorize";
  idempotencyKey: string;
  confidence: number;
  /** Flat payload — a human revise produces readable preference diffs. */
  payload: {
    txnId: string;
    action: "expense" | "job-cost" | "personal" | "exclude";
    accountCode?: string;
    jobId?: string;
    costCode?: string;
    kind?: string;
    description: string;
    amountCents: number;
    postedOn: string;
  };
  /** Authoritative figures the summary may quote (cents). */
  figures: number[];
}

export const FALLBACK_EXPENSE_ACCOUNT = "8990";

/** Tiny stable hash (djb2) over the decision-relevant payload fields. */
function proposalHash(p: Record<string, unknown>): string {
  const s = JSON.stringify([p.action, p.accountCode, p.jobId, p.costCode, p.kind]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Deterministic proposal choice, in priority order:
 *   1. a learned rule suggestion (the tenant taught us this merchant),
 *   2. the personal-spend heuristic flag,
 *   3. money-in -> income question,
 *   4. unknown money-out -> expense question defaulting to the account the
 *      human last confirmed (or the fallback), at LOW confidence — the
 *      human's edit is the learning signal that makes next time better.
 */
export function buildQuestionCard(txn: QueueTxn, ctx: CardContext): QuestionCard {
  const display = {
    txnId: txn.id,
    description: txn.description,
    amountCents: txn.amountCents,
    postedOn: txn.postedOn,
  };
  // The key covers txn + proposal content: re-asking an IDENTICAL question
  // a human already rejected dedupes away (no nagging), while a different
  // proposal for the same still-pending txn is a legitimately new card.
  const finish = (
    confidence: number,
    payload: QuestionCard["payload"],
  ): QuestionCard => ({
    kind: "bank.categorize",
    idempotencyKey: `fin:categorize:${txn.id}:${proposalHash(payload)}`,
    figures: [txn.amountCents, Math.abs(txn.amountCents)],
    confidence,
    payload,
  });

  if (
    txn.suggestion?.action === "job-cost" &&
    txn.amountCents < 0 &&
    ctx.jobs.length > 0 &&
    // No cost codes set up means no job-cost proposal. The card falls
    // through to the expense path, which the bookkeeper can still change to
    // a job cost by hand — a proposal with a made-up code cannot be
    // un-made-up once it is approved.
    ctx.defaultCostCode
  ) {
    return finish(ctx.jobs.length === 1 ? 80 : 50, {
      ...display,
      action: "job-cost",
      jobId: ctx.jobs[0]!.id,
      costCode: ctx.defaultCostCode,
      kind: "material",
    });
  }
  if (txn.suggestion?.action === "expense" && txn.suggestion.accountCode) {
    return finish(85, { ...display, action: "expense", accountCode: txn.suggestion.accountCode });
  }
  if ((txn.suggestion?.action === "personal" || txn.personalSuspect) && txn.amountCents < 0) {
    return finish(70, { ...display, action: "personal" });
  }
  return finish(30, {
    ...display,
    action: "expense",
    accountCode: ctx.lastExpenseAccount ?? FALLBACK_EXPENSE_ACCOUNT,
  });
}
