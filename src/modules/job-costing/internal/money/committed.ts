// Committed costs — money you've promised but not yet spent (open POs +
// expected sub invoices). The classic small-contractor blind spot: the budget
// looks fine until the committed dollars land. Pure, integer cents.
import { assertCents, formatMoney, type Cents } from "@/lib/money/cents";
import { JobCostError } from "./wip";

export interface CommittedInput {
  budgetCents: Cents;
  actualCents: Cents; // costs already posted
  openPoCents: Cents; // POs issued, not yet received/billed
  expectedSubCents: Cents; // sub work performed/contracted, not yet billed
}

export interface CommittedResult {
  committedCents: Cents;
  /** budget − actual − committed. Negative = you're already over. */
  remainingCents: Cents;
  /** The floor of where this job's cost ends up: actual + committed. */
  projectedFloorCents: Cents;
  overCommitted: boolean;
}

export function computeCommitted(input: CommittedInput): CommittedResult {
  const budget = assertCents(input.budgetCents);
  const actual = assertCents(input.actualCents);
  const po = assertCents(input.openPoCents);
  const sub = assertCents(input.expectedSubCents);
  if (budget < 0 || actual < 0 || po < 0 || sub < 0) {
    throw new JobCostError("committed_inputs_must_be_nonnegative");
  }
  const committed = po + sub;
  const remaining = budget - actual - committed;
  return {
    committedCents: committed,
    remainingCents: remaining,
    projectedFloorCents: actual + committed,
    overCommitted: remaining < 0,
  };
}

export function explainCommitted(r: CommittedResult): string {
  if (r.overCommitted) {
    return `Careful — between what you've spent and what you've already promised (orders and subs), this job is $${formatMoney(-r.remainingCents)} OVER budget before the bills even arrive.`;
  }
  return `You've spent or promised $${formatMoney(r.projectedFloorCents)} so far. There's $${formatMoney(r.remainingCents)} of budget left after everything you've committed to.`;
}
