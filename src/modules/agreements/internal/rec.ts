// Pure revenue-recognition math for service agreements. No I/O — the store
// posts what these functions compute, tests prove them exhaustively first
// (the S3 doctrine: money math is deterministic, never improvised at the
// call site).
import { mulDivHalfUp } from "@/lib/money/cents";

/**
 * The policy, as Cory set it (2026-08-03):
 *
 *   ANNUAL prepay — the whole year's price parks in 2430 Deferred income
 *   ("advance payments not yet earned" — already in every tenant's NAHB
 *   chart) and is EARNED PER COMPLETED VISIT. Whatever a lopsided division
 *   leaves over rides with the LAST visit; anything still deferred when the
 *   plan year ends releases then (the obligation lapsed).
 *
 *   MONTHLY billing — each month's fee buys that month's standing benefits
 *   (priority, discount, the promise of visits), so it earns in the month
 *   billed. Nothing defers. Mixing the two treatments is the standard read:
 *   deferral follows PREPAYMENT, and a monthly member hasn't prepaid
 *   anything.
 */

/**
 * How much revenue each completed visit releases from deferred income.
 *
 * Returns exactly `visits` amounts summing to EXACTLY `totalCents` — the
 * invariant that keeps 2430 draining to zero rather than leaving a one-cent
 * crumb on the balance sheet forever. $229.00 over 2 visits = 114.50 +
 * 114.50; $100.00 over 3 = 33.33 + 33.33 + 33.34 (last visit takes the
 * remainder).
 */
export function visitReleaseSchedule(totalCents: number, visits: number): number[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new Error("totalCents must be a non-negative integer");
  }
  if (!Number.isSafeInteger(visits) || visits <= 0) {
    throw new Error("visits must be a positive integer");
  }
  const base = mulDivHalfUp(totalCents, 1, visits);
  const amounts = Array.from({ length: visits }, () => base);
  // Half-up rounding can land the shares a cent high or low in total; the
  // last visit absorbs the difference in either direction.
  amounts[visits - 1] = totalCents - base * (visits - 1);
  return amounts;
}

/**
 * The deferred balance still owed to the member after `completed` visits —
 * the refundable ceiling on a mid-year cancellation, and the amount that
 * releases at plan year-end if visits never happened.
 */
export function deferredBalanceCents(
  totalCents: number,
  visitsPerYear: number,
  completed: number,
): number {
  if (completed < 0) throw new Error("completed cannot be negative");
  const schedule = visitReleaseSchedule(totalCents, visitsPerYear);
  const released = schedule
    .slice(0, Math.min(completed, visitsPerYear))
    .reduce((s, v) => s + v, 0);
  return totalCents - released;
}

/**
 * Member discount on an invoice subtotal, in cents, from the plan's basis
 * points. 15% = 1500 bps. Half-up, consistent with every other rounding in
 * the system. Posts to 3490 Sales concessions and discounts (contra-revenue,
 * already seeded) — a discount is revenue given back, not an expense.
 */
export function memberDiscountCents(subtotalCents: number, discountBps: number): number {
  if (!Number.isSafeInteger(discountBps) || discountBps < 0 || discountBps > 10_000) {
    throw new Error("discountBps out of range");
  }
  return mulDivHalfUp(subtotalCents, discountBps, 10_000);
}

/**
 * The visit due-months for a plan year. Plans carry target months (e.g.
 * [4, 10] — April and October for HVAC); a plan with more visits than
 * targets spreads the rest evenly. Returns ISO dates on the 1st.
 */
export function visitDueDates(
  periodStartIso: string,
  visitsPerYear: number,
  targetMonths: number[],
): string[] {
  const start = new Date(`${periodStartIso}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) throw new Error("bad periodStart");
  const months =
    targetMonths.length >= visitsPerYear
      ? targetMonths.slice(0, visitsPerYear)
      : // No/short preference: spread evenly across the year.
        Array.from({ length: visitsPerYear }, (_, i) =>
          ((start.getUTCMonth() + Math.floor((12 / visitsPerYear) * i)) % 12) + 1,
        );

  return (
    months
      .map((m) => {
        // Month-bucket semantics: the visit belongs to month m of the plan
        // year. A target month earlier in the calendar than the start month
        // rolls to the next calendar year. (A plan starting Apr 10 with an
        // April target is due THAT April — the 1st is a bucket label, not an
        // appointment time.)
        const y =
          m >= start.getUTCMonth() + 1
            ? start.getUTCFullYear()
            : start.getUTCFullYear() + 1;
        return `${y}-${String(m).padStart(2, "0")}-01`;
      })
      // Chronological, not target-list order: a June start with targets
      // [4, 10] is due Oct 2026 THEN Apr 2027.
      .sort()
  );
}
