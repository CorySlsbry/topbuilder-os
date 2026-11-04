import { describe, expect, it } from "vitest";
import { mulDivHalfUp } from "@/lib/money/cents";
import { computeWip, explainWip, explainWipPortfolio, JobCostError } from "./wip";
import { computeBurdenedLabor } from "./burden";
import { computeCommitted } from "./committed";
import { computeCodeBudget, rollupJobBudget } from "./budget";

// Golden fixture: a GENERIC demo contractor — deliberately not tied to any
// client or state (Cory 2026-07-23).
const D = 100; // dollars → cents

describe("mulDivHalfUp (the one rounding primitive)", () => {
  it("rounds half up", () => {
    expect(mulDivHalfUp(1, 1, 2)).toBe(1); // 0.5 → 1
    expect(mulDivHalfUp(1, 1, 3)).toBe(0); // 0.33 → 0
    expect(mulDivHalfUp(2, 1, 3)).toBe(1); // 0.67 → 1
  });
  it("survives products beyond 2^53 (BigInt path)", () => {
    expect(mulDivHalfUp(9007199254740, 1000, 7)).toBe(1286742750677143);
  });
  it("rejects division by zero", () => {
    expect(() => mulDivHalfUp(1, 1, 0)).toThrow();
  });
});

describe("WIP / percentage-of-completion", () => {
  const base = {
    contractCents: 100_000 * D,
    costsToDateCents: 40_000 * D,
    estCostToCompleteCents: 40_000 * D,
    billedToDateCents: 40_000 * D,
  };

  it("happy path: 50% complete, earned half the contract", () => {
    const r = computeWip(base);
    expect(r.estTotalCostCents).toBe(80_000 * D);
    expect(r.pctCompleteBps).toBe(5000);
    expect(r.earnedRevenueCents).toBe(50_000 * D);
    expect(r.grossProfitCents).toBe(10_000 * D);
    expect(r.underbilledCents).toBe(10_000 * D); // earned 50k, billed 40k
    expect(r.overbilledCents).toBe(0);
  });

  it("a job is in exactly ONE bucket (over- vs under-billed)", () => {
    const over = computeWip({ ...base, billedToDateCents: 70_000 * D });
    expect(over.overbilledCents).toBe(20_000 * D);
    expect(over.underbilledCents).toBe(0);
    const exact = computeWip({ ...base, billedToDateCents: 50_000 * D });
    expect(exact.overbilledCents).toBe(0);
    expect(exact.underbilledCents).toBe(0);
  });

  it("approved change order raises the contract and earned revenue", () => {
    const r = computeWip({ ...base, contractCents: 120_000 * D });
    expect(r.earnedRevenueCents).toBe(60_000 * D);
  });

  it("zero estimate → 0% and a flag, never NaN/Infinity", () => {
    const r = computeWip({
      ...base,
      costsToDateCents: 0,
      estCostToCompleteCents: 0,
    });
    expect(r.pctCompleteBps).toBe(0);
    expect(r.earnedRevenueCents).toBe(0);
    expect(r.flags.zeroEstimate).toBe(true);
  });

  it("ETC = 0 with costs → 100% complete, earned capped at contract", () => {
    const r = computeWip({ ...base, estCostToCompleteCents: 0 });
    expect(r.pctCompleteBps).toBe(10_000);
    expect(r.earnedRevenueCents).toBe(100_000 * D);
  });

  it("projected loss job flags (est total cost > contract)", () => {
    const r = computeWip({
      ...base,
      costsToDateCents: 55_000 * D,
      estCostToCompleteCents: 55_000 * D,
    });
    expect(r.flags.lossJob).toBe(true);
    expect(r.grossProfitCents).toBe(-5_000 * D); // earned 50k − costs 55k
  });

  it("billed past contract flags", () => {
    const r = computeWip({ ...base, billedToDateCents: 130_000 * D });
    expect(r.flags.billedPastContract).toBe(true);
  });

  it("stale estimate-to-complete flags after 30 days with active costs", () => {
    expect(computeWip({ ...base, etcAgeDays: 45 }).flags.staleEtc).toBe(true);
    expect(computeWip({ ...base, etcAgeDays: 10 }).flags.staleEtc).toBe(false);
  });

  it("deterministic cent rounding (half-up) on awkward ratios", () => {
    const r = computeWip({
      contractCents: 10_000,
      costsToDateCents: 1,
      estCostToCompleteCents: 2,
      billedToDateCents: 0,
    });
    expect(r.pctCompleteBps).toBe(3333);
    expect(r.earnedRevenueCents).toBe(3333); // 10000 × 1/3, half-up
  });

  it("negative inputs are a typed error, never a silent 0", () => {
    expect(() => computeWip({ ...base, costsToDateCents: -1 })).toThrow(
      JobCostError,
    );
  });

  it("explains itself in plain language with verbatim figures", () => {
    expect(explainWip(computeWip(base))).toContain("bill $10,000.00 more");
  });
});

describe("the WIP portfolio totals, in plain English", () => {
  const totals = {
    underbilledCents: 4_000_00,
    overbilledCents: 4_000_00,
    contractCents: 900_000_00,
    costsCents: 300_000_00,
    earnedCents: 400_000_00,
    billedCents: 400_000_00,
  };

  it("reports under and over SEPARATELY — never netted to zero", () => {
    // The classic WIP mistake. $4,000 underbilled on one job and $4,000
    // overbilled on another is not "fine": it is one invoice nobody sent and
    // one customer who has paid for work still owed.
    const text = explainWipPortfolio(totals);
    expect(text).toContain("$4,000.00 of work you haven't invoiced");
    expect(text).toContain("paid $4,000.00 ahead");
    expect(text).not.toContain("Nothing to chase");
  });

  it("says nothing to chase only when BOTH sides are zero", () => {
    const text = explainWipPortfolio({ ...totals, underbilledCents: 0, overbilledCents: 0 });
    expect(text).toContain("Nothing to chase");
  });

  it("an empty portfolio gets a sentence, not a wall of zeros", () => {
    expect(explainWipPortfolio({ ...totals, contractCents: 0 })).toContain("no open jobs");
  });
});

describe("burdened labor", () => {
  it("40h × $45 loaded (no burden components) = $1,800", () => {
    const r = computeBurdenedLabor(4000, 0, { baseHourlyCents: 4500, ficaBps: 0 });
    expect(r.totalCents).toBe(180_000);
  });

  it("full burden: base $30 + FICA 7.65% + WC $15/$100 + $2/h benefits", () => {
    const r = computeBurdenedLabor(4000, 0, {
      baseHourlyCents: 3000,
      ficaBps: 765,
      wcPer100Cents: 1500,
      benefitsHourlyCents: 200,
    });
    expect(r.wagesCents).toBe(120_000);
    expect(r.burdenCents).toBe(27_180 + 8_000); // 22.65% of wages + benefits
    expect(r.totalCents).toBe(155_180);
  });

  it("overtime at 1.5×, percentage burden on ALL wages incl. premium", () => {
    const r = computeBurdenedLabor(4000, 1000, {
      baseHourlyCents: 3000,
      ficaBps: 765,
      wcPer100Cents: 1500,
      benefitsHourlyCents: 200,
    });
    expect(r.wagesCents).toBe(165_000); // 120000 + 45000 OT
    expect(r.burdenCents).toBe(37_373 + 10_000);
    expect(r.totalCents).toBe(212_373);
  });

  it("zero/missing rate is a hard error — never a silent $0 burden", () => {
    expect(() =>
      computeBurdenedLabor(4000, 0, { baseHourlyCents: 0, ficaBps: 765 }),
    ).toThrow(JobCostError);
  });
});

describe("committed costs", () => {
  it("over-committed before the bills arrive", () => {
    const r = computeCommitted({
      budgetCents: 60_000 * D,
      actualCents: 30_000 * D,
      openPoCents: 20_000 * D,
      expectedSubCents: 15_000 * D,
    });
    expect(r.committedCents).toBe(35_000 * D);
    expect(r.remainingCents).toBe(-5_000 * D);
    expect(r.overCommitted).toBe(true);
    expect(r.projectedFloorCents).toBe(65_000 * D);
  });

  it("no commitments → remaining is simply budget − actual", () => {
    const r = computeCommitted({
      budgetCents: 60_000 * D,
      actualCents: 30_000 * D,
      openPoCents: 0,
      expectedSubCents: 0,
    });
    expect(r.remainingCents).toBe(30_000 * D);
    expect(r.overCommitted).toBe(false);
  });
});

describe("budget-vs-actual by cost code", () => {
  it("on-budget line: projected equals budget, variance zero", () => {
    const r = computeCodeBudget({
      costCode: "4100",
      budgetCents: 20_000 * D,
      actualCents: 18_000 * D,
      etcCents: 2_000 * D,
    });
    expect(r.projectedFinalCents).toBe(20_000 * D);
    expect(r.varianceCents).toBe(0);
    expect(r.flags.overrun).toBe(false);
  });

  it("overrun and unbudgeted flags fire", () => {
    expect(
      computeCodeBudget({
        costCode: "4100",
        budgetCents: 20_000 * D,
        actualCents: 18_000 * D,
        etcCents: 4_000 * D,
      }).flags.overrun,
    ).toBe(true);
    expect(
      computeCodeBudget({
        costCode: "9999",
        budgetCents: 0,
        actualCents: 500,
        etcCents: 0,
      }).flags.unbudgeted,
    ).toBe(true);
  });

  it("rollup reconciles: job totals are the sum of the code lines", () => {
    const codes = [
      computeCodeBudget({ costCode: "a", budgetCents: 100, actualCents: 40, etcCents: 50 }),
      computeCodeBudget({ costCode: "b", budgetCents: 200, actualCents: 150, etcCents: 80 }),
    ];
    const r = rollupJobBudget(codes);
    expect(r.budgetCents).toBe(300);
    expect(r.actualCents).toBe(190);
    expect(r.projectedFinalCents).toBe(320);
    expect(r.varianceCents).toBe(-20);
  });
});
