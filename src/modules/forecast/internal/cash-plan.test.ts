import { describe, expect, it } from "vitest";
import {
  addWeeks,
  collectionLagDays,
  computeCashPlan,
  DEFAULT_LAG_DAYS,
  explainCashPlan,
  mondayOf,
  overclaimedJobs,
  PLAN_WEEKS,
  type CashItem,
} from "./cash-plan";

const money = (c: number) =>
  (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const MONDAY = "2026-08-10";

function plan(items: CashItem[], startingCashCents = 2_000_00) {
  return computeCashPlan({ startingCashCents, items, firstWeekStart: MONDAY, });
}

describe("the three balances answer three different questions", () => {
  const items: CashItem[] = [
    { week: 0, cents: 5_000_00, certainty: "contracted", label: "Invoice #12 due" },
    { week: 1, cents: 8_000_00, certainty: "scheduled", label: "Change-out on the board" },
    { week: 1, cents: -3_000_00, certainty: "expected", label: "Payroll" },
    { week: 2, cents: 20_000_00, certainty: "possible", label: "Backlog: Henderson re-roof" },
  ];

  it("committed counts ONLY what is signed and dated", () => {
    const p = plan(items);
    expect(p.weeks[0]!.committedCents).toBe(5_000_00);
    // Scheduled work and payroll are both absent from the signed-only view.
    expect(p.weeks[1]!.committedCents).toBe(0);
    expect(p.weeks[1]!.committedBalanceCents).toBe(7_000_00);
  });

  it("likely adds the calendar and the bills you know are coming", () => {
    const p = plan(items);
    expect(p.weeks[1]!.likelyCents).toBe(5_000_00); // 8,000 in - 3,000 payroll
    expect(p.weeks[1]!.likelyBalanceCents).toBe(12_000_00);
  });

  it("possible adds the backlog, and only the backlog", () => {
    const p = plan(items);
    expect(p.weeks[2]!.possibleCents).toBe(20_000_00);
    expect(p.weeks[2]!.likelyCents).toBe(0);
  });

  it("⛔ likely can sit BELOW committed — payroll is an expected OUTFLOW", () => {
    // The named case. A reader seeing "likely" under "committed" will assume a
    // bug unless the software says why, so the behaviour is pinned and the
    // explainer has a sentence for it.
    const payrollOnly: CashItem[] = [
      { week: 0, cents: 1_000_00, certainty: "contracted", label: "Invoice #9" },
      { week: 0, cents: -6_000_00, certainty: "expected", label: "Payroll" },
    ];
    const p = plan(payrollOnly);
    expect(p.weeks[0]!.committedBalanceCents).toBe(3_000_00);
    expect(p.weeks[0]!.likelyBalanceCents).toBe(-3_000_00);
    expect(p.low.likely.balanceCents).toBeLessThan(p.low.committed.balanceCents);

    const text = explainCashPlan(p, collectionLagDays([]), money);
    expect(text).toContain("payroll and overhead are in this one");
  });

  it("has no percentage anywhere in the numbers OR the words", () => {
    // A percentage invites the reader to multiply by it, which is the one
    // piece of arithmetic nobody here can defend.
    const p = plan(items);
    const text = explainCashPlan(p, collectionLagDays([]), money);
    expect(text).not.toMatch(/%|percent|confidence|likelihood/i);
    expect(JSON.stringify(p)).not.toContain("Bps");
  });
});

describe("week 13 is a horizon, not a dumping ground", () => {
  it("money past the horizon is reported BESIDE the plan, never summed in", () => {
    // The old forecast piled everything past week 13 INTO week 13, producing a
    // cheerful spike exactly where a reader stops looking.
    const p = plan([
      { week: 0, cents: 1_000_00, certainty: "contracted", label: "near" },
      { week: PLAN_WEEKS, cents: 90_000_00, certainty: "contracted", label: "far" },
      { week: 40, cents: 10_000_00, certainty: "contracted", label: "much further" },
    ]);
    expect(p.beyondCents).toBe(100_000_00);
    const last = p.weeks[PLAN_WEEKS - 1]!;
    expect(last.committedCents).toBe(0);
    expect(last.committedBalanceCents).toBe(3_000_00); // 2,000 start + 1,000
  });

  it("always returns exactly 13 weeks, starting on the Monday given", () => {
    const p = plan([]);
    expect(p.weeks).toHaveLength(13);
    expect(p.weeks[0]!.weekStart).toBe(MONDAY);
    expect(p.weeks[12]!.weekStart).toBe("2026-11-02");
  });
});

describe("collectionLagDays — median, not mean, with a sample floor", () => {
  it("⛔ one 300-day deadbeat must not move the plan", () => {
    const days = [20, 22, 25, 28, 30, 31, 33, 300];
    const mean = days.reduce((a, b) => a + b, 0) / days.length; // 61
    const r = collectionLagDays(days);
    expect(r.days).toBe(29); // median of the middle two, 28 and 30
    expect(r.days).toBeLessThan(mean);
    expect(r.isDefault).toBe(false);
    expect(r.samples).toBe(8);
  });

  it("under 8 samples it keeps the default and SAYS so", () => {
    const r = collectionLagDays([12, 14, 15]);
    expect(r.days).toBe(DEFAULT_LAG_DAYS);
    expect(r.isDefault).toBe(true);
    expect(r.samples).toBe(3);

    const text = explainCashPlan(plan([]), r, money);
    expect(text).toContain("aren't enough paid invoices yet");
    expect(text).not.toContain("Based on your last");
  });

  it("names the real sample count once there is history", () => {
    const text = explainCashPlan(plan([]), collectionLagDays([10, 11, 12, 13, 14, 15, 16, 17, 18]), money);
    expect(text).toContain("Based on your last 9 paid invoices");
    expect(text).toContain("14 days");
  });

  it("ignores nonsense rather than letting it into the median", () => {
    const r = collectionLagDays([10, 11, 12, 13, 14, 15, 16, 17, NaN, -5]);
    expect(r.samples).toBe(8);
    expect(r.isDefault).toBe(false);
  });
});

describe("⛔ the no-double-count invariant", () => {
  it("catches the same remaining contract claimed three times", () => {
    // $40,000 of remaining contract showing up as underbilled AND scheduled
    // AND backlog is how a plan reports $120,000 and an owner hires someone.
    const bad = overclaimedJobs([
      {
        jobId: "job-1",
        contractCents: 100_000_00,
        billedCents: 60_000_00,
        underbilledCents: 40_000_00,
        scheduledCents: 40_000_00,
        backlogCents: 40_000_00,
      },
    ]);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.claimedCents).toBe(120_000_00);
    expect(bad[0]!.availableCents).toBe(40_000_00);
  });

  it("allows an allocation that exactly fills the remaining contract", () => {
    expect(
      overclaimedJobs([
        {
          jobId: "job-1",
          contractCents: 100_000_00,
          billedCents: 60_000_00,
          underbilledCents: 15_000_00,
          scheduledCents: 20_000_00,
          backlogCents: 5_000_00,
        },
      ]),
    ).toEqual([]);
  });

  it("an over-billed job has NOTHING left to claim, not a negative allowance", () => {
    // Without the floor at zero, a job billed past its contract would hand out
    // a negative allowance that other rows could borrow against.
    const bad = overclaimedJobs([
      {
        jobId: "job-1",
        contractCents: 50_000_00,
        billedCents: 60_000_00,
        underbilledCents: 0,
        scheduledCents: 1_00,
        backlogCents: 0,
      },
    ]);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.availableCents).toBe(0);
  });
});

describe("date helpers", () => {
  it("mondayOf snaps to the Monday on or before", () => {
    expect(mondayOf("2026-08-12")).toBe("2026-08-10"); // Wednesday
    expect(mondayOf("2026-08-10")).toBe("2026-08-10"); // Monday itself
    expect(mondayOf("2026-08-09")).toBe("2026-08-03"); // Sunday belongs to the week before
  });

  it("addWeeks crosses a month boundary without drifting", () => {
    expect(addWeeks("2026-08-24", 2)).toBe("2026-09-07");
  });
});

describe("negative balances read as words, not as a minus glued to a dollar sign", () => {
  it("says IN THE RED rather than $-3,800.00", () => {
    // The same rule the job-profit explainer follows. A reader on the one line
    // telling them they are about to run out of money should not have to
    // decode a character first.
    const p = plan([{ week: 0, cents: -6_000_00, certainty: "contracted", label: "Payroll" }]);
    const text = explainCashPlan(p, collectionLagDays([]), money);
    expect(text).toContain("IN THE RED");
    expect(text).not.toContain("$-");
    expect(text).toContain("$4,000.00"); // the magnitude, stated positively
  });

  it("still reads plainly when the plan stays above water", () => {
    const p = plan([{ week: 0, cents: 1_000_00, certainty: "contracted", label: "Invoice" }]);
    const text = explainCashPlan(p, collectionLagDays([]), money);
    expect(text).not.toContain("IN THE RED");
    // 2,000 starting + 1,000 in week 0, and nothing moves after that.
    expect(text).toContain("lowest point is $3,000.00");
  });
});
