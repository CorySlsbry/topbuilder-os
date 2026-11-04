import { describe, expect, it } from "vitest";
import {
  deferredBalanceCents,
  memberDiscountCents,
  visitDueDates,
  visitReleaseSchedule,
} from "./rec";

/**
 * The invariant that matters most: every schedule sums EXACTLY to the total.
 * A one-cent leak here is a 2430 Deferred income balance that never reaches
 * zero — a permanent crumb on the balance sheet that the bank rec can see
 * but nobody can explain.
 */
describe("visitReleaseSchedule", () => {
  it("splits the demo plan cleanly: $229.00 over 2 visits", () => {
    expect(visitReleaseSchedule(22900, 2)).toEqual([11450, 11450]);
  });

  it("last visit absorbs an upward remainder: $100.00 over 3", () => {
    expect(visitReleaseSchedule(10000, 3)).toEqual([3333, 3333, 3334]);
  });

  it("last visit absorbs a DOWNWARD remainder: $200.00 over 3", () => {
    // Half-up base is 6667; 3×6667 overshoots, so the last visit gives a
    // cent back. Both directions must work or the sum invariant breaks.
    expect(visitReleaseSchedule(20000, 3)).toEqual([6667, 6667, 6666]);
  });

  it("sums exactly for every total and visit count in a broad sweep", () => {
    for (let total = 0; total <= 5000; total += 37) {
      for (let visits = 1; visits <= 12; visits++) {
        const schedule = visitReleaseSchedule(total, visits);
        expect(schedule).toHaveLength(visits);
        expect(schedule.reduce((s, v) => s + v, 0)).toBe(total);
        // No visit releases a negative amount, even on tiny totals.
        for (const v of schedule) expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("one visit takes everything; zero total is all zeros", () => {
    expect(visitReleaseSchedule(22900, 1)).toEqual([22900]);
    expect(visitReleaseSchedule(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it("rejects garbage", () => {
    expect(() => visitReleaseSchedule(-1, 2)).toThrow();
    expect(() => visitReleaseSchedule(100.5, 2)).toThrow();
    expect(() => visitReleaseSchedule(100, 0)).toThrow();
    expect(() => visitReleaseSchedule(100, -3)).toThrow();
  });
});

describe("deferredBalanceCents", () => {
  it("walks the demo plan down to zero", () => {
    expect(deferredBalanceCents(22900, 2, 0)).toBe(22900);
    expect(deferredBalanceCents(22900, 2, 1)).toBe(11450);
    expect(deferredBalanceCents(22900, 2, 2)).toBe(0);
  });

  it("caps at zero when more visits completed than planned", () => {
    expect(deferredBalanceCents(22900, 2, 5)).toBe(0);
  });

  it("tracks the lopsided schedule, not naive division", () => {
    // $100/3: after 2 visits the balance is 10000-6666 = 3334, not 3333.33.
    expect(deferredBalanceCents(10000, 3, 2)).toBe(3334);
  });
});

describe("memberDiscountCents", () => {
  it("computes the demo plan's 15% repair discount", () => {
    expect(memberDiscountCents(78500, 1500)).toBe(11775);
  });

  it("rounds half-up at the boundary", () => {
    // 15% of $0.33 = 4.95¢ → 5¢
    expect(memberDiscountCents(33, 1500)).toBe(5);
    // 10% of $0.05 = 0.5¢ → 1¢ (half-up, same rule as everywhere else)
    expect(memberDiscountCents(5, 1000)).toBe(1);
  });

  it("zero bps means zero discount; out-of-range throws", () => {
    expect(memberDiscountCents(78500, 0)).toBe(0);
    expect(() => memberDiscountCents(100, -1)).toThrow();
    expect(() => memberDiscountCents(100, 10_001)).toThrow();
  });
});

describe("visitDueDates", () => {
  it("spring/fall HVAC plan starting in January", () => {
    expect(visitDueDates("2026-01-15", 2, [4, 10])).toEqual([
      "2026-04-01",
      "2026-10-01",
    ]);
  });

  it("rolls a target month that already passed into the next year — chronologically", () => {
    // June start: October is still ahead this year; April is next year.
    expect(visitDueDates("2026-06-01", 2, [4, 10])).toEqual([
      "2026-10-01",
      "2027-04-01",
    ]);
  });

  it("a start-month target belongs to the start month (bucket semantics)", () => {
    expect(visitDueDates("2026-04-10", 1, [4])).toEqual(["2026-04-01"]);
  });

  it("spreads evenly when the plan has no month preferences", () => {
    expect(visitDueDates("2026-01-15", 4, [])).toEqual([
      "2026-01-01",
      "2026-04-01",
      "2026-07-01",
      "2026-10-01",
    ]);
  });

  it("uses only as many targets as there are visits", () => {
    expect(visitDueDates("2026-01-15", 1, [4, 10])).toEqual(["2026-04-01"]);
  });
});
