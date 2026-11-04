import { describe, expect, it } from "vitest";
import {
  computeCipRow,
  computeFadeRow,
  computeSuretyRatios,
  explainCip,
  explainFade,
  explainRatios,
  summarizeFade,
} from "./surety";

/**
 * These numbers go in front of a surety underwriter and a bank. Every one of
 * them is arithmetic somebody could check by hand, so every one of them is
 * asserted against a hand calculation here.
 */

const cip = (over: Partial<Parameters<typeof computeCipRow>[0]> = {}) =>
  computeCipRow({
    contractCents: 100_000_00,
    pendingChangeOrderCents: 0,
    costsToDateCents: 40_000_00,
    estCostToCompleteCents: 40_000_00,
    billedToDateCents: 45_000_00,
    retainageHeldCents: 0,
    ...over,
  });

describe("the contracts-in-progress schedule", () => {
  it("computes the underwriter's columns from a hand calculation", () => {
    // $100k contract, $80k estimated total cost, $40k spent → 50% complete.
    // Earned = 100k × 50% = $50k. Billed $45k → $5k UNDERbilled.
    // Gross profit earned = 50k − 40k = $10k. Estimated GP = 100k − 80k = $20k.
    const r = cip();
    expect(r.estTotalCostCents).toBe(80_000_00);
    expect(r.pctCompleteBps).toBe(5_000);
    expect(r.earnedRevenueCents).toBe(50_000_00);
    expect(r.grossProfitEarnedCents).toBe(10_000_00);
    expect(r.estGrossProfitCents).toBe(20_000_00);
    expect(r.estGrossMarginBps).toBe(2_000); // 20%
    expect(r.underbilledCents).toBe(5_000_00);
    expect(r.overbilledCents).toBe(0);
    expect(r.remainingToBillCents).toBe(55_000_00);
    expect(r.grossProfitRemainingCents).toBe(10_000_00);
  });

  it("⛔ NEVER adds unapproved change orders into the contract", () => {
    // Booking unapproved COs as contract value is the most common way a WIP
    // schedule lies, and it is the first thing an underwriter tests. They get
    // their own column and touch nothing else.
    const plain = cip();
    const withPending = cip({ pendingChangeOrderCents: 25_000_00 });
    expect(withPending.pendingChangeOrderCents).toBe(25_000_00);
    expect(withPending.contractCents).toBe(plain.contractCents);
    expect(withPending.earnedRevenueCents).toBe(plain.earnedRevenueCents);
    expect(withPending.estGrossProfitCents).toBe(plain.estGrossProfitCents);
    expect(withPending.underbilledCents).toBe(plain.underbilledCents);
  });

  it("flags pending change orders that are material to the contract", () => {
    expect(cip({ pendingChangeOrderCents: 9_000_00 }).flags.materialPendingCos).toBe(false);
    expect(cip({ pendingChangeOrderCents: 11_000_00 }).flags.materialPendingCos).toBe(true);
  });

  it("shows a projected LOSS job as a negative gross profit, not a zero", () => {
    // $100k contract that will cost $120k. Hiding the sign would be the one
    // thing a surety cannot forgive.
    const r = cip({ costsToDateCents: 60_000_00, estCostToCompleteCents: 60_000_00 });
    expect(r.estGrossProfitCents).toBe(-20_000_00);
    expect(r.estGrossMarginBps).toBe(-2_000);
    expect(r.flags.lossJob).toBe(true);
  });

  it("keeps over- and under-billing in separate buckets", () => {
    const under = cip({ billedToDateCents: 30_000_00 });
    const over = cip({ billedToDateCents: 70_000_00 });
    expect([under.underbilledCents, under.overbilledCents]).toEqual([20_000_00, 0]);
    expect([over.underbilledCents, over.overbilledCents]).toEqual([0, 20_000_00]);
  });

  it("carries retainage through as its own figure", () => {
    // Retainage is a separate current asset on the balance sheet and a
    // surety wants it identified, not buried in AR.
    expect(cip({ retainageHeldCents: 5_000_00 }).retainageHeldCents).toBe(5_000_00);
  });

  it("returns null rather than a fake margin on a zero contract", () => {
    expect(cip({ contractCents: 0 }).estGrossMarginBps).toBeNull();
  });
});

describe("profit fade", () => {
  const fade = (over: Partial<Parameters<typeof computeFadeRow>[0]> = {}) =>
    computeFadeRow({
      finalContractCents: 100_000_00,
      finalCostCents: 85_000_00,
      estGrossProfitAtAwardCents: 20_000_00,
      estGrossProfitAtLastSnapshotCents: 18_000_00,
      ...over,
    });

  it("measures the job against what it was SOLD at", () => {
    // Expected $20k, made $15k → faded $5k, 500 bps of the contract.
    const r = fade();
    expect(r.actualGrossProfitCents).toBe(15_000_00);
    expect(r.fadeFromAwardCents).toBe(-5_000_00);
    expect(r.fadeFromAwardBps).toBe(-500);
  });

  it("separately measures FORECASTING against estimating", () => {
    // A shop can bid badly and still track honestly. An underwriter treats
    // those very differently, so they are two columns, not one.
    expect(fade().fadeFromLastSnapshotCents).toBe(-3_000_00);
  });

  it("reports a GAIN with the same sign convention", () => {
    const r = fade({ finalCostCents: 75_000_00 });
    expect(r.actualGrossProfitCents).toBe(25_000_00);
    expect(r.fadeFromAwardCents).toBe(5_000_00);
  });

  it("says NULL, not zero, when there is no baseline to fade from", () => {
    // A job with no original budget has nothing to compare against.
    // Reporting "0 fade" would claim it finished exactly as estimated.
    const r = fade({ estGrossProfitAtAwardCents: null });
    expect(r.fadeFromAwardCents).toBeNull();
    expect(r.fadeFromAwardBps).toBeNull();
  });

  it("summarises the portfolio the way an underwriter reads it", () => {
    const rows = [
      fade(), // −$5k
      fade({ finalCostCents: 75_000_00 }), // +$5k
      fade({ finalCostCents: 95_000_00 }), // −$15k
      fade({ estGrossProfitAtAwardCents: null }), // no baseline
    ];
    const s = summarizeFade(rows);
    expect(s.jobsWithBaseline).toBe(3);
    expect(s.jobsFaded).toBe(2);
    expect(s.jobsImproved).toBe(1);
    expect(s.totalFadeCents).toBe(-15_000_00);
    // −$15k across $300k of contracts = −500 bps.
    expect(s.weightedFadeBps).toBe(-500);
    expect(s.worstFadeCents).toBe(-15_000_00);
  });

  it("a portfolio with no baselines summarises to nothing, not to zero fade", () => {
    const s = summarizeFade([computeFadeRow({
      finalContractCents: 10_000_00,
      finalCostCents: 9_000_00,
      estGrossProfitAtAwardCents: null,
      estGrossProfitAtLastSnapshotCents: null,
    })]);
    expect(s.jobsWithBaseline).toBe(0);
    expect(s.weightedFadeBps).toBeNull();
    expect(s.worstFadeCents).toBeNull();
  });
});

describe("the surety ratio panel", () => {
  const base = {
    currentAssetsCents: 500_000_00,
    currentLiabilitiesCents: 300_000_00,
    totalAssetsCents: 700_000_00,
    totalLiabilitiesCents: 400_000_00,
    equityCents: 300_000_00,
    intangibleAndRelatedPartyCents: 50_000_00,
    revenueCents: 2_000_000_00,
    arCents: 250_000_00,
    underbilledCents: 60_000_00,
    periodDays: 365,
  };

  it("computes each ratio against a hand calculation", () => {
    const r = computeSuretyRatios(base);
    expect(r.workingCapitalCents).toBe(200_000_00); // 500 − 300
    expect(r.currentRatioBps).toBe(16_667); // 500/300 = 1.6667×
    expect(r.debtToEquityBps).toBe(13_333); // 400/300 = 1.3333×
    expect(r.tangibleNetWorthCents).toBe(250_000_00); // 300 − 50
    expect(r.revenueToWorkingCapitalBps).toBe(100_000); // 2000/200 = 10×
    expect(r.daysInAr).toBe(46); // 250/2000 × 365
    expect(r.underbillingsToEquityBps).toBe(2_000); // 60/300 = 20%
  });

  it("⛔ refuses to divide by zero equity instead of reporting infinity", () => {
    // Negative or zero equity is not "infinite leverage", it is a different
    // conversation. A number here would imply the ratio still means something.
    const r = computeSuretyRatios({ ...base, equityCents: 0 });
    expect(r.debtToEquityBps).toBeNull();
    expect(r.underbillingsToEquityBps).toBeNull();
    expect(r.tangibleNetWorthCents).toBe(-50_000_00); // still meaningful
  });

  it("refuses a revenue-to-working-capital ratio when working capital is gone", () => {
    // Negative working capital with revenue flowing is the overtrading
    // signal itself; a ratio would hide it behind a negative number.
    const r = computeSuretyRatios({ ...base, currentLiabilitiesCents: 600_000_00 });
    expect(r.workingCapitalCents).toBe(-100_000_00);
    expect(r.revenueToWorkingCapitalBps).toBeNull();
  });

  it("reports no days-in-AR for a shop with no revenue yet", () => {
    expect(computeSuretyRatios({ ...base, revenueCents: 0 }).daysInAr).toBeNull();
  });
});

describe("the plain-language explainers", () => {
  it("names unapproved change orders out loud", () => {
    const s = explainCip([cip({ pendingChangeOrderCents: 25_000_00 })]);
    expect(s).toContain("not approved");
    expect(s).toContain("NOT counted");
  });

  it("names a loss job out loud", () => {
    const s = explainCip([cip({ costsToDateCents: 60_000_00, estCostToCompleteCents: 60_000_00 })]);
    expect(s).toContain("loss");
  });

  it("says what fade MEANS to an underwriter, in both directions", () => {
    const bad = explainFade(summarizeFade([computeFadeRow({
      finalContractCents: 100_000_00, finalCostCents: 90_000_00,
      estGrossProfitAtAwardCents: 20_000_00, estGrossProfitAtLastSnapshotCents: null,
    })]));
    expect(bad).toContain("LESS");
    expect(bad).toContain("discount");

    const good = explainFade(summarizeFade([computeFadeRow({
      finalContractCents: 100_000_00, finalCostCents: 70_000_00,
      estGrossProfitAtAwardCents: 20_000_00, estGrossProfitAtLastSnapshotCents: null,
    })]));
    expect(good).toContain("MORE");
    expect(good).toContain("believe");
  });

  it("is honest that there is nothing to say when there is no baseline", () => {
    expect(explainFade(summarizeFade([]))).toContain("no fade to measure yet");
  });

  it("⛔ never asserts a bonding capacity number", () => {
    // The multiple is the underwriter's call and varies by carrier. Software
    // that prints "you can bond $2.5M" is making a promise it cannot keep.
    const s = explainRatios(computeSuretyRatios({
      currentAssetsCents: 500_000_00, currentLiabilitiesCents: 300_000_00,
      totalAssetsCents: 700_000_00, totalLiabilitiesCents: 400_000_00,
      equityCents: 300_000_00, intangibleAndRelatedPartyCents: 0,
      revenueCents: 2_000_000_00, arCents: 250_000_00,
      underbilledCents: 10_000_00, periodDays: 365,
    }));
    expect(s).toContain("underwriter's call");
    expect(s).not.toMatch(/you can bond|capacity of \$|eligible for \$/i);
  });

  it("warns when net worth leans on unbilled work", () => {
    const s = explainRatios(computeSuretyRatios({
      currentAssetsCents: 500_000_00, currentLiabilitiesCents: 300_000_00,
      totalAssetsCents: 700_000_00, totalLiabilitiesCents: 400_000_00,
      equityCents: 100_000_00, intangibleAndRelatedPartyCents: 0,
      revenueCents: 2_000_000_00, arCents: 250_000_00,
      underbilledCents: 50_000_00, periodDays: 365, // 50% of equity
    }));
    expect(s).toContain("unbilled work");
  });
});
