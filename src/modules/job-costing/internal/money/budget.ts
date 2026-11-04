// Budget-vs-actual by cost code — "did we make money on that job?" answered
// live, per line, while there's still time to steer. Pure, integer cents.
import { assertCents, formatMoney, type Cents } from "@/lib/money/cents";
import { JobCostError } from "./wip";

export interface CodeBudgetInput {
  costCode: string;
  budgetCents: Cents;
  actualCents: Cents;
  /** Estimate-to-complete for THIS code (0 when done or unknown). */
  etcCents: Cents;
}

export interface CodeBudgetResult {
  costCode: string;
  budgetCents: Cents;
  actualCents: Cents;
  projectedFinalCents: Cents; // actual + etc
  varianceCents: Cents; // budget − projected (negative = overrun)
  flags: { overrun: boolean; unbudgeted: boolean };
}

export function computeCodeBudget(input: CodeBudgetInput): CodeBudgetResult {
  const budget = assertCents(input.budgetCents);
  const actual = assertCents(input.actualCents);
  const etc = assertCents(input.etcCents);
  if (budget < 0 || actual < 0 || etc < 0) {
    throw new JobCostError("budget_inputs_must_be_nonnegative");
  }
  const projected = actual + etc;
  const variance = budget - projected;
  return {
    costCode: input.costCode,
    budgetCents: budget,
    actualCents: actual,
    projectedFinalCents: projected,
    varianceCents: variance,
    flags: {
      overrun: variance < 0,
      unbudgeted: budget === 0 && actual > 0,
    },
  };
}

export interface JobBudgetRollup {
  codes: CodeBudgetResult[];
  budgetCents: Cents;
  actualCents: Cents;
  projectedFinalCents: Cents;
  varianceCents: Cents;
}

/** Roll up code lines to the job. Sums MUST reconcile — enforced, not hoped. */
export function rollupJobBudget(codes: CodeBudgetResult[]): JobBudgetRollup {
  let budget = 0;
  let actual = 0;
  let projected = 0;
  for (const c of codes) {
    budget += c.budgetCents;
    actual += c.actualCents;
    projected += c.projectedFinalCents;
  }
  return {
    codes,
    budgetCents: budget,
    actualCents: actual,
    projectedFinalCents: projected,
    varianceCents: budget - projected,
  };
}

export function explainJobBudget(r: JobBudgetRollup): string {
  const overruns = r.codes.filter((c) => c.flags.overrun).length;
  if (r.varianceCents < 0) {
    return `This job is heading $${formatMoney(-r.varianceCents)} OVER budget (${overruns} cost ${overruns === 1 ? "line is" : "lines are"} running hot). Catching it now means you can fix pricing or scope before the money is gone.`;
  }
  return `This job is on track to come in $${formatMoney(r.varianceCents)} UNDER budget. Nice — that's profit you keep if nothing slips.`;
}
