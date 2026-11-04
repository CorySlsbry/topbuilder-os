// Personal-expense handling — the top-0.1%-CPA treatment of the most common
// small-shop reality: personal spending on the business card.
//
// The rule: a personal purchase is NEVER a business expense and NEVER a job
// cost. It still cleared the bank, so it still reconciles — it just posts to
// the owner's side of the balance sheet:
//   sole prop / SMLLC / partnership → owner draws (equity)
//   S-corp / C-corp                 → due from owner (asset/loan) — a corp's
//                                     cash isn't the shareholder's wallet.
// Detection here is a deterministic HEURISTIC that only FLAGS for review;
// a human marks it personal (or the learned rules do, after promotion).
// Nothing posts without the gate.
import { formatMoney, type Cents } from "@/lib/money/cents";
import type { EntryInput } from "@/modules/ledger";
import { JobCostError } from "./wip";

export type EntityType =
  | "sole-prop"
  | "partnership"
  | "smllc"
  | "s-corp"
  | "c-corp";

/** Which balance-sheet destination personal spend posts to, by entity type. */
export function personalDestination(
  entity: EntityType,
): "owner-draws" | "due-from-owner" {
  return entity === "s-corp" || entity === "c-corp"
    ? "due-from-owner"
    : "owner-draws";
}

export interface PersonalReclassInput {
  entityType: EntityType;
  amountCents: Cents;
  occurredOn: string; // yyyy-mm-dd
  /** The bank/credit-card GL account the spend cleared. */
  cashAccountCode: string;
  /** The tenant's owner-draws (equity) account code. */
  drawsAccountCode: string;
  /** The tenant's due-from-owner (asset) account code. */
  dueFromOwnerAccountCode: string;
  memo?: string;
  sourceId?: string;
}

/**
 * Build the journal entry that reconciles a personal purchase correctly:
 * DR draws-or-loan / CR cash. No expense account, no job dimension — it can
 * never leak into the P&L or job costing.
 */
export function buildPersonalReclass(input: PersonalReclassInput): EntryInput {
  if (input.amountCents <= 0) {
    throw new JobCostError("personal_amount_must_be_positive");
  }
  const destination =
    personalDestination(input.entityType) === "owner-draws"
      ? input.drawsAccountCode
      : input.dueFromOwnerAccountCode;
  return {
    occurredOn: input.occurredOn,
    memo: input.memo ?? "Personal purchase — reclassified off the business books",
    sourceType: "personal-reclass",
    sourceId: input.sourceId,
    lines: [
      { accountCode: destination, debitCents: input.amountCents },
      { accountCode: input.cashAccountCode, creditCents: input.amountCents },
    ],
  };
}

// ----------------------------------------------------------- flag heuristic
// Deliberately modest: obvious-personal merchant categories. It creates a
// REVIEW FLAG, never a posting. The learning loop (approve/revise/reject →
// rule promotion) sharpens per-tenant behavior over time.
const PERSONAL_HINTS: readonly string[] = [
  "grocery", "supermarket", "liquor", "wine", "brewery",
  "netflix", "spotify", "hulu", "disney", "steam", "playstation", "xbox",
  "salon", "spa ", "barber", "nail",
  "resort", "cruise", "vacation", "theme park", "disneyland",
  "toys", "toy store", "gamestop",
  "pet", "veterinar",
  "daycare", "tuition", "preschool",
];

export interface PersonalSuspicion {
  suspect: boolean;
  reason?: string;
}

export function suspectPersonal(merchantOrMemo: string): PersonalSuspicion {
  const text = merchantOrMemo.toLowerCase();
  for (const hint of PERSONAL_HINTS) {
    if (text.includes(hint)) {
      return { suspect: true, reason: `looks like ${hint.trim()}` };
    }
  }
  return { suspect: false };
}

export function explainPersonal(
  entity: EntityType,
  amountCents: Cents,
): string {
  const dest = personalDestination(entity);
  if (dest === "owner-draws") {
    return `This $${formatMoney(amountCents)} was marked personal, so it won't count as a business cost or touch any job. It's recorded as money you took out of the company (an owner draw). The bank still balances to the penny.`;
  }
  return `This $${formatMoney(amountCents)} was marked personal. Because the company is a corporation, it's recorded as money the company lent you — you'll want to pay it back or run it through payroll. It never touches profit or any job, and the bank still balances.`;
}
