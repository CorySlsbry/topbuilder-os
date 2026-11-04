// "What did this job actually make me?" — pure, integer cents, no I/O.
//
// The system already computes a gross profit, and it is NOT this number.
// `computeWip` returns `earnedRevenue − costsToDate`, where earned revenue is
// contract × percent-complete and percent-complete is driven by the owner's
// estimate-to-complete. That figure is correct and useful, and it MOVES WHEN
// SOMEBODY EDITS A GUESS.
//
// So there are two questions, and conflating them is the bug:
//   "how is this job tracking?"   → WIP gross profit, an accounting position
//   "what did this job make me?"  → billed (or collected) minus cost, made
//                                   only of things that happened
//
// The crew sees the second one, if the owner turns it on at all. A tech
// watching "their" profit swing because someone re-estimated the job is a
// trust event, not a feature.

import { mulDivHalfUp, type Cents } from "@/lib/money/cents";

export interface JobProfitInput {
  contractCents: Cents;
  /** Pre-tax, voids excluded — the same basis WIP uses. Sales tax is a
   *  pass-through liability, not revenue, and never profit. */
  billedCents: Cents;
  /** Σ payments received against this job's invoices. */
  collectedCents: Cents;
  /** Σ cost_entries: materials, subs, equipment, and POSTED labor. */
  postedCostsCents: Cents;
  /**
   * Burdened labor sitting in `time_entries` that nobody has posted yet.
   *
   * Without this the number is a lie for most of the week: hours contribute
   * ZERO to cost until someone presses post, so between Monday and the weekly
   * close a job looks more profitable than it is by exactly its entire labor
   * content.
   */
  unpostedLaborCents: Cents;
}

export interface JobProfitResult {
  /** Echoed so `explainJobProfit` needs only the result — every explainer in
   *  this codebase takes one argument, and a template that has to be handed
   *  the inputs too is a template that can be handed the wrong ones. */
  billedCents: Cents;
  collectedCents: Cents;
  totalCostsCents: Cents;
  billedProfitCents: Cents;
  billedMarginBps: number;
  collectedProfitCents: Cents;
  collectedMarginBps: number;
  /** Contract not yet invoiced. Never negative — billing past the contract is
   *  a flag, not a negative backlog. */
  unbilledContractCents: Cents;
  flags: {
    /** Some cost is hours nobody has posted; the figure will move on close. */
    unpostedLaborPresent: boolean;
    /** Nothing invoiced yet, so "profit" is just cost with a minus sign. */
    noBillingYet: boolean;
    /**
     * Nothing COLLECTED yet — the invoice is out and unpaid.
     *
     * Without this, collected profit renders as a large negative beside a
     * healthy billed profit, and an owner glancing at the card sees a loss on
     * a job that is doing fine. The figure is arithmetically right and the
     * impression is wrong, which is worse than a missing number. The screen
     * shows "nothing collected yet" instead.
     */
    noCollectionYet: boolean;
    /** Spent more than billed. */
    underwater: boolean;
  };
}

export function computeJobProfit(input: JobProfitInput): JobProfitResult {
  const totalCostsCents = input.postedCostsCents + input.unpostedLaborCents;
  const billedProfitCents = input.billedCents - totalCostsCents;
  const collectedProfitCents = input.collectedCents - totalCostsCents;

  // Margin against the money BILLED, not the contract: a half-billed job at a
  // healthy margin should read as healthy, not as half a margin. Guarded at
  // zero because a job with nothing invoiced has no margin, not an infinite
  // negative one. mulDivHalfUp carries the sign, so a loss reads negative.
  const billedMarginBps =
    input.billedCents === 0 ? 0 : mulDivHalfUp(billedProfitCents, 10_000, input.billedCents);
  const collectedMarginBps =
    input.collectedCents === 0
      ? 0
      : mulDivHalfUp(collectedProfitCents, 10_000, input.collectedCents);

  return {
    billedCents: input.billedCents,
    collectedCents: input.collectedCents,
    totalCostsCents,
    billedProfitCents,
    billedMarginBps,
    collectedProfitCents,
    collectedMarginBps,
    unbilledContractCents: Math.max(0, input.contractCents - input.billedCents),
    flags: {
      unpostedLaborPresent: input.unpostedLaborCents > 0,
      noBillingYet: input.billedCents === 0,
      noCollectionYet: input.collectedCents === 0,
      underwater: billedProfitCents < 0,
    },
  };
}

/**
 * What a crew member is shown when the shop has switched job profit on.
 *
 * This is a SUBTRACTION, and the test that matters asserts the absence of
 * things rather than the presence of them. Four keys are deliberately gone:
 *
 * - **no ETC and no WIP figures** — they move when the owner edits a guess,
 *   and a tech watching "their" profit swing because the job got re-estimated
 *   is a trust event, not a feature.
 * - **no over/under billing** — an accounting position, not information a
 *   person in a truck can act on.
 * - **no costsByCode** — this is the sharp one. A cost-by-code breakdown with
 *   `kind: 'labor'` on a two-person job is a payroll disclosure: divide by the
 *   hours on the same screen and you have the other guy's rate.
 *
 * Returning a NEW object rather than deleting keys from the full one is the
 * point. A future field added to JobProfitResult does not silently appear
 * here; someone has to decide to add it, which is exactly the decision this
 * function exists to force.
 */
export interface CrewProfitView {
  billedCents: Cents;
  totalCostsCents: Cents;
  billedProfitCents: Cents;
  billedMarginBps: number;
  /**
   * Its OWN sentence, not the owner's.
   *
   * `explainJobProfit` ends with "there's still $X of the contract you haven't
   * invoiced" — an office action item, and a figure this view deliberately
   * does not carry. Reusing it would have leaked through the prose the object
   * was careful about, which is the quiet way redaction fails.
   */
  explain: string;
}

export function crewProfitView(
  r: JobProfitResult,
  money: (cents: number) => string,
): CrewProfitView {
  return {
    billedCents: r.billedCents,
    totalCostsCents: r.totalCostsCents,
    billedProfitCents: r.billedProfitCents,
    billedMarginBps: r.billedMarginBps,
    explain: explainCrewProfit(r, money),
  };
}

/** The crew's sentence: only the four figures the crew view carries. */
export function explainCrewProfit(
  r: JobProfitResult,
  money: (cents: number) => string,
): string {
  if (r.flags.noBillingYet) {
    return `This job has cost ${money(r.totalCostsCents)} so far and hasn't been invoiced yet.`;
  }
  const cents = Math.abs(Math.round(r.billedMarginBps / 100));
  const shape = r.flags.underwater
    ? `so it has LOST ${money(-r.billedProfitCents)} so far — ${cents} cents underwater on every dollar billed`
    : `so it has made ${money(r.billedProfitCents)} so far — about ${cents} cents of every dollar`;
  const base = `This job has billed ${money(r.billedCents)} and cost ${money(r.totalCostsCents)}, ${shape}.`;
  // Kept, unlike the other caveats: without it the number looks final on a
  // Wednesday and lands lower on Friday, which reads as the shop moving the
  // goalposts. Honesty about what is still coming is the point of showing it.
  return r.flags.unpostedLaborPresent
    ? `${base} Some hours haven't been posted yet, so this will move when the week is closed.`
    : base;
}

/**
 * The sentence a person actually reads. Deterministic template, figures
 * verbatim from the result — the house rule for every money module.
 */
export function explainJobProfit(
  r: JobProfitResult,
  money: (cents: number) => string,
): string {
  if (r.flags.noBillingYet) {
    const base = `You've spent ${money(r.totalCostsCents)} on this job and haven't invoiced anything yet.`;
    return r.flags.unpostedLaborPresent
      ? `${base} Some of that is hours nobody has posted, so it will settle when the week is closed.`
      : base;
  }

  const cents = Math.abs(Math.round(r.billedMarginBps / 100));
  const shape = r.flags.underwater
    ? `so it has LOST you ${money(-r.billedProfitCents)} so far`
    : `so it has made you ${money(r.billedProfitCents)} so far`;
  const rate = r.flags.underwater
    ? ` — you're ${cents} cents underwater on every dollar billed`
    : ` — about ${cents} cents of every dollar`;

  const parts = [
    `You've billed ${money(r.billedCents)} on this job and spent ${money(r.totalCostsCents)}, ${shape}${rate}.`,
  ];
  if (r.unbilledContractCents > 0) {
    parts.push(`There's still ${money(r.unbilledContractCents)} of the contract you haven't invoiced.`);
  }
  if (r.flags.unpostedLaborPresent) {
    parts.push("Some of that spending is hours nobody has posted yet.");
  }
  return parts.join(" ");
}
