// The 13-week cash plan — pure, integer cents, no I/O, no model.
//
// ── Why this exists when a forecast already did ───────────────────────────
// The old forecast knows three things: cash on hand, open AR, open AP. It is
// honest and it is blind to the calendar. A shop with $40k of signed work on
// next week's board and nothing invoiced yet sees a flat line.
//
// ── The design problem, stated plainly ────────────────────────────────────
// Everything past "money already owed to us" is a guess, and a plan built on
// guesses that LOOKS like a plan built on facts is worse than no plan. So the
// question is not "how do we predict better" — it is "how do we show a person
// which parts of this are real".
//
// The answer here is: certainty is a CATEGORY DERIVED FROM STRUCTURE, never a
// score and never a model output.
//
//   contracted — signed, dated, already in the books. An issued invoice; an
//                autopay renewal with a card on file. Facts.
//   scheduled  — on the calendar with money attached. The work exists and the
//                date exists; only the billing hasn't happened yet.
//   expected   — recurring, from the owner's OWN stated assumption. Payroll
//                every other Friday because they said so.
//   possible   — backlog. Contracted work with no date on it.
//
// A shop can look at any row and say "yes, that's signed" or "no, that job
// slipped". They cannot do that with "73% confidence".
//
// ⛔ NO PERCENTAGES ANYWHERE. A number like 73% invites the reader to multiply
// by it, which is exactly the arithmetic nobody can defend. Three balances,
// three plain sentences, and the reader decides.

import { type Cents } from "@/lib/money/cents";

export type Certainty = "contracted" | "scheduled" | "expected" | "possible";

/** How many weeks the plan covers before everything else becomes "beyond". */
export const PLAN_WEEKS = 13;

export interface CashItem {
  /** 0-based week. Anything at or past PLAN_WEEKS lands in `beyond`. */
  week: number;
  /** Positive is money in, negative is money out. One sign convention. */
  cents: Cents;
  certainty: Certainty;
  /** What it is, in the shop's words. Shown on the row. */
  label: string;
  /**
   * The job this belongs to, when it belongs to one. Used ONLY by the
   * no-double-count check — the plan itself never groups by job.
   */
  jobId?: string;
}

export interface CashPlanInput {
  startingCashCents: Cents;
  items: CashItem[];
  /** ISO Monday of week 0. Passed in so this stays pure and testable. */
  firstWeekStart: string;
}

export interface CashPlanWeek {
  weekStart: string;
  /** Signed, dated, in the books. */
  committedCents: Cents;
  /** Contracted + scheduled + expected. */
  likelyCents: Cents;
  /** Everything, backlog included. */
  possibleCents: Cents;
  /** Running balances, one per certainty band. */
  committedBalanceCents: Cents;
  likelyBalanceCents: Cents;
  possibleBalanceCents: Cents;
}

export interface CashPlan {
  startingCashCents: Cents;
  weeks: CashPlanWeek[];
  /**
   * Money dated past the horizon.
   *
   * Reported BESIDE the plan and never summed into a balance. The old
   * forecast piled everything past week 13 into week 13, which produced a
   * cheerful spike exactly where a reader stops looking — the shape of the
   * chart said "we end rich" when it meant "we stopped counting".
   */
  beyondCents: Cents;
  /** The worst week in each band, which is the thing an owner actually reads. */
  low: {
    committed: { weekStart: string; balanceCents: Cents };
    likely: { weekStart: string; balanceCents: Cents };
  };
}

const BANDS: Record<Certainty, { committed: boolean; likely: boolean }> = {
  contracted: { committed: true, likely: true },
  scheduled: { committed: false, likely: true },
  expected: { committed: false, likely: true },
  possible: { committed: false, likely: false },
};

export function computeCashPlan(input: CashPlanInput): CashPlan {
  const weeks: CashPlanWeek[] = [];
  let committedBalance = input.startingCashCents;
  let likelyBalance = input.startingCashCents;
  let possibleBalance = input.startingCashCents;
  let beyondCents = 0;

  for (const item of input.items) {
    if (item.week >= PLAN_WEEKS) beyondCents += item.cents;
  }

  for (let w = 0; w < PLAN_WEEKS; w++) {
    const inWeek = input.items.filter((i) => i.week === w);
    const committedCents = sum(inWeek.filter((i) => BANDS[i.certainty].committed));
    const likelyCents = sum(inWeek.filter((i) => BANDS[i.certainty].likely));
    const possibleCents = sum(inWeek);

    committedBalance += committedCents;
    likelyBalance += likelyCents;
    possibleBalance += possibleCents;

    weeks.push({
      weekStart: addWeeks(input.firstWeekStart, w),
      committedCents,
      likelyCents,
      possibleCents,
      committedBalanceCents: committedBalance,
      likelyBalanceCents: likelyBalance,
      possibleBalanceCents: possibleBalance,
    });
  }

  const lowestBy = (pick: (w: CashPlanWeek) => Cents) =>
    weeks.reduce((m, w) => (pick(w) < pick(m) ? w : m), weeks[0]!);
  const lowCommitted = lowestBy((w) => w.committedBalanceCents);
  const lowLikely = lowestBy((w) => w.likelyBalanceCents);

  return {
    startingCashCents: input.startingCashCents,
    weeks,
    beyondCents,
    low: {
      committed: {
        weekStart: lowCommitted.weekStart,
        balanceCents: lowCommitted.committedBalanceCents,
      },
      likely: { weekStart: lowLikely.weekStart, balanceCents: lowLikely.likelyBalanceCents },
    },
  };
}

function sum(items: CashItem[]): Cents {
  return items.reduce((t, i) => t + i.cents, 0);
}

/** Pure date maths on an ISO date, in UTC. No timezone opinion needed: a week
 *  boundary in a cash plan is a label, not an appointment. */
export function addWeeks(isoDate: string, weeks: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

/** The Monday on or before a date. Week 0 of every plan. */
export function mondayOf(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * How long this shop's customers ACTUALLY take to pay.
 *
 * ⛔ MEDIAN, not mean. One customer who paid after 300 days drags a mean into
 * fiction and moves every week of the plan. The median says "half of them beat
 * this", which is both more robust and easier to defend to the person reading
 * it.
 *
 * ⛔ And a SAMPLE FLOOR. Under 8 paid invoices there is no pattern, only
 * anecdotes, so the plan keeps its default and the explainer says so out loud.
 * A new shop should not have its cash plan swung by the two customers who
 * happened to pay first.
 */
export const MIN_LAG_SAMPLES = 8;
export const DEFAULT_LAG_DAYS = 30;

export interface CollectionLag {
  days: number;
  /** How many paid invoices went into it. */
  samples: number;
  /** True when we fell back to the default for want of history. */
  isDefault: boolean;
}

export function collectionLagDays(daysToPay: number[]): CollectionLag {
  const clean = daysToPay.filter((d) => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
  if (clean.length < MIN_LAG_SAMPLES) {
    return { days: DEFAULT_LAG_DAYS, samples: clean.length, isDefault: true };
  }
  const mid = Math.floor(clean.length / 2);
  // Even counts average the two middle values, then round to a whole day —
  // half a day of precision in a 13-week plan is noise pretending to be rigour.
  const median =
    clean.length % 2 === 1 ? clean[mid]! : Math.round((clean[mid - 1]! + clean[mid]!) / 2);
  return { days: median, samples: clean.length, isDefault: false };
}

/**
 * ⛔ THE NO-DOUBLE-COUNT INVARIANT — the whole game.
 *
 * A job's remaining contract can be claimed by at most one row of the plan. If
 * the same $40,000 shows up as "underbilled work you can invoice", again as
 * "scheduled next month", and again as "backlog", the plan says $120,000 and
 * an owner makes a hiring decision on it.
 *
 * For every job: underbilled + scheduled + backlog <= contract - billed.
 *
 * Returns the jobs that violate it. A caller that gets a non-empty array has a
 * bug, not a warning — and the test for this is not optional.
 */
export interface JobClaim {
  jobId: string;
  contractCents: Cents;
  billedCents: Cents;
  underbilledCents: Cents;
  scheduledCents: Cents;
  backlogCents: Cents;
}

export function overclaimedJobs(claims: JobClaim[]): {
  jobId: string;
  claimedCents: Cents;
  availableCents: Cents;
}[] {
  const bad: { jobId: string; claimedCents: Cents; availableCents: Cents }[] = [];
  for (const c of claims) {
    const claimed = c.underbilledCents + c.scheduledCents + c.backlogCents;
    // Over-billed jobs have nothing left to claim; the floor is zero rather
    // than a negative allowance that would let other rows borrow against it.
    const available = Math.max(0, c.contractCents - c.billedCents);
    if (claimed > available) {
      bad.push({ jobId: c.jobId, claimedCents: claimed, availableCents: available });
    }
  }
  return bad;
}

/**
 * The plan in plain English. Deterministic template, figures verbatim.
 *
 * Three sentences because there are three answers, and collapsing them into
 * one is how a hedge becomes a prediction.
 */
export function explainCashPlan(
  plan: CashPlan,
  lag: CollectionLag,
  money: (cents: number) => string,
): string {
  const parts: string[] = [];

  /**
   * The house rule for money in prose: the WORDS carry the direction, never a
   * minus sign glued to a dollar amount.
   *
   * `money(-380000)` renders "$-3,800.00", which makes a reader stop and
   * decode a character before they can read the sentence — on the one line
   * that is trying to tell them they are about to run out of money.
   */
  const short = (cents: Cents) =>
    cents < 0 ? `${money(-cents)} IN THE RED` : money(cents);

  parts.push(
    plan.low.committed.balanceCents < 0
      ? `If ONLY the work that's already signed and invoiced happens, you run out around the week of ${plan.low.committed.weekStart} and go ${short(plan.low.committed.balanceCents)}.`
      : `If ONLY the work that's already signed and invoiced happens, your lowest point is ${short(plan.low.committed.balanceCents)} the week of ${plan.low.committed.weekStart}.`,
  );

  // The likely line can sit BELOW the committed one, and that is not a bug:
  // payroll and overhead are expected OUTflows that the signed-only view has
  // not counted yet. Saying it out loud stops it reading as an error.
  parts.push(
    plan.low.likely.balanceCents < plan.low.committed.balanceCents
      ? `Once the bills you know are coming are counted too, that low point becomes ${short(plan.low.likely.balanceCents)} the week of ${plan.low.likely.weekStart} — lower, because payroll and overhead are in this one.`
      : `If the calendar holds and everyone pays as usual, your low point is ${short(plan.low.likely.balanceCents)} the week of ${plan.low.likely.weekStart}.`,
  );

  if (plan.beyondCents !== 0) {
    parts.push(
      `There's another ${money(Math.abs(plan.beyondCents))} dated past these 13 weeks. It is NOT in the numbers above.`,
    );
  }

  parts.push(
    lag.isDefault
      ? `We're assuming customers pay in about ${lag.days} days, because there aren't enough paid invoices yet to tell how yours really behave.`
      : `Based on your last ${lag.samples} paid invoices, customers take about ${lag.days} days to pay.`,
  );

  return parts.join(" ");
}
