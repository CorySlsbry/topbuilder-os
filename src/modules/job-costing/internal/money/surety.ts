/**
 * The schedules a surety underwriter actually reads.
 *
 * ── WHAT AN UNDERWRITER IS DOING ─────────────────────────────────────────
 * Not admiring the P&L. Answering one question: "if this contractor walks off
 * a job, what does it cost me?" Every column below is instrumentation for
 * that question, which is why the shapes are so specific and why netting two
 * of them together destroys the information.
 *
 * Pure, integer cents, deterministic — same rules as the rest of the money
 * layer. Ratios are BASIS POINTS, never floats, and a ratio whose denominator
 * is zero comes back NULL rather than Infinity: "not meaningful" is a real
 * answer and handing an underwriter an Infinity is worse than handing them
 * nothing.
 */
import { assertCents, mulDivHalfUp, formatMoney, type Cents } from "@/lib/money/cents";
import { computeWip, type WipResult } from "./wip";

// ══════════════════════════════════════ contracts in progress (the WIP schedule)

export interface CipInput {
  /** Contract price INCLUDING approved change orders. */
  contractCents: Cents;
  /**
   * Change orders sent but not yet approved.
   *
   * ⛔ REPORTED SEPARATELY AND NEVER ADDED IN. Booking unapproved change
   * orders as contract value is the single most common way a WIP schedule
   * lies, and it is the first thing an underwriter tests. Disclosing them in
   * their own column is the difference between a schedule that builds trust
   * and one that costs it.
   */
  pendingChangeOrderCents: Cents;
  costsToDateCents: Cents;
  estCostToCompleteCents: Cents;
  billedToDateCents: Cents;
  /** Retainage the customer is holding on billings to date. */
  retainageHeldCents: Cents;
  etcAgeDays?: number;
}

export interface CipRow {
  contractCents: Cents;
  pendingChangeOrderCents: Cents;
  estTotalCostCents: Cents;
  /** Contract − estimated total cost. NEGATIVE means a projected loss job. */
  estGrossProfitCents: number;
  /** Basis points of the contract. Null when there is no contract to divide by. */
  estGrossMarginBps: number | null;
  pctCompleteBps: number;
  costsToDateCents: Cents;
  earnedRevenueCents: Cents;
  /** Gross profit EARNED so far = earned revenue − costs to date. */
  grossProfitEarnedCents: number;
  billedToDateCents: Cents;
  retainageHeldCents: Cents;
  /** Costs and earnings in excess of billings — a current ASSET. */
  underbilledCents: Cents;
  /** Billings in excess of costs and earnings — a current LIABILITY. */
  overbilledCents: Cents;
  /** Contract still to invoice. */
  remainingToBillCents: number;
  /** Gross profit still to earn = est gross profit − gross profit earned. */
  grossProfitRemainingCents: number;
  flags: WipResult["flags"] & {
    /** Pending change orders are material relative to the contract (>10%). */
    materialPendingCos: boolean;
  };
}

export function computeCipRow(input: CipInput): CipRow {
  const contract = assertCents(input.contractCents);
  const pending = assertCents(input.pendingChangeOrderCents);
  const retainage = assertCents(input.retainageHeldCents);

  const wip = computeWip({
    contractCents: contract,
    costsToDateCents: input.costsToDateCents,
    estCostToCompleteCents: input.estCostToCompleteCents,
    billedToDateCents: input.billedToDateCents,
    etcAgeDays: input.etcAgeDays,
  });

  const estGross = contract - wip.estTotalCostCents;
  return {
    contractCents: contract,
    pendingChangeOrderCents: pending,
    estTotalCostCents: wip.estTotalCostCents,
    estGrossProfitCents: estGross,
    estGrossMarginBps: contract === 0 ? null : ratioBps(estGross, contract),
    pctCompleteBps: wip.pctCompleteBps,
    costsToDateCents: assertCents(input.costsToDateCents),
    earnedRevenueCents: wip.earnedRevenueCents,
    grossProfitEarnedCents: wip.grossProfitCents,
    billedToDateCents: assertCents(input.billedToDateCents),
    retainageHeldCents: retainage,
    underbilledCents: wip.underbilledCents,
    overbilledCents: wip.overbilledCents,
    remainingToBillCents: contract - assertCents(input.billedToDateCents),
    grossProfitRemainingCents: estGross - wip.grossProfitCents,
    flags: {
      ...wip.flags,
      materialPendingCos: contract > 0 && pending > 0 && ratioBps(pending, contract) > 1_000,
    },
  };
}

// ══════════════════════════════════════════ completed contracts + profit fade

export interface FadeInput {
  /** Final contract price including approved change orders. */
  finalContractCents: Cents;
  /** Total costs actually incurred. */
  finalCostCents: Cents;
  /**
   * The gross profit the shop EXPECTED when it took the job — original
   * contract award less original budget. Null when the job predates any
   * budget, in which case there is nothing to fade FROM and the row says so
   * rather than inventing a baseline.
   */
  estGrossProfitAtAwardCents: number | null;
  /**
   * Gross profit still expected at the LAST WIP snapshot before completion.
   * This is what the owner was telling everyone — including their surety —
   * while the job was running.
   */
  estGrossProfitAtLastSnapshotCents: number | null;
}

export interface FadeRow {
  finalContractCents: Cents;
  finalCostCents: Cents;
  actualGrossProfitCents: number;
  actualGrossMarginBps: number | null;
  estGrossProfitAtAwardCents: number | null;
  estGrossProfitAtLastSnapshotCents: number | null;
  /**
   * Actual minus the estimate at award. NEGATIVE is fade — the job finished
   * worse than it was sold. This is the number that decides whether an
   * underwriter believes the CURRENT WIP schedule's earned profit.
   */
  fadeFromAwardCents: number | null;
  /** Fade as basis points of the contract, so big and small jobs compare. */
  fadeFromAwardBps: number | null;
  /**
   * Actual minus the last snapshot. This one measures FORECASTING, not
   * estimating: a shop can bid badly but track honestly, and an underwriter
   * treats those very differently.
   */
  fadeFromLastSnapshotCents: number | null;
}

export function computeFadeRow(input: FadeInput): FadeRow {
  const contract = assertCents(input.finalContractCents);
  const cost = assertCents(input.finalCostCents);
  const actual = contract - cost;
  const award = input.estGrossProfitAtAwardCents;
  const last = input.estGrossProfitAtLastSnapshotCents;

  return {
    finalContractCents: contract,
    finalCostCents: cost,
    actualGrossProfitCents: actual,
    actualGrossMarginBps: contract === 0 ? null : ratioBps(actual, contract),
    estGrossProfitAtAwardCents: award,
    estGrossProfitAtLastSnapshotCents: last,
    fadeFromAwardCents: award === null ? null : actual - award,
    fadeFromAwardBps:
      award === null || contract === 0 ? null : ratioBps(actual - award, contract),
    fadeFromLastSnapshotCents: last === null ? null : actual - last,
  };
}

export interface FadeSummary {
  jobsWithBaseline: number;
  jobsFaded: number;
  jobsImproved: number;
  totalFadeCents: number;
  /** Weighted by contract value: total fade / total contract, in bps. */
  weightedFadeBps: number | null;
  /** The worst single job, for the conversation an underwriter will start. */
  worstFadeCents: number | null;
}

export function summarizeFade(rows: FadeRow[]): FadeSummary {
  const withBaseline = rows.filter((r) => r.fadeFromAwardCents !== null);
  const totalFade = withBaseline.reduce((t, r) => t + (r.fadeFromAwardCents ?? 0), 0);
  const totalContract = withBaseline.reduce((t, r) => t + r.finalContractCents, 0);
  return {
    jobsWithBaseline: withBaseline.length,
    jobsFaded: withBaseline.filter((r) => (r.fadeFromAwardCents ?? 0) < 0).length,
    jobsImproved: withBaseline.filter((r) => (r.fadeFromAwardCents ?? 0) > 0).length,
    totalFadeCents: totalFade,
    weightedFadeBps: totalContract === 0 ? null : ratioBps(totalFade, totalContract),
    worstFadeCents:
      withBaseline.length === 0
        ? null
        : Math.min(...withBaseline.map((r) => r.fadeFromAwardCents ?? 0)),
  };
}

// ══════════════════════════════════════════════════════ the ratio panel

export interface SuretyRatioInput {
  currentAssetsCents: Cents;
  currentLiabilitiesCents: Cents;
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  equityCents: number;
  /** Goodwill, related-party receivables — what a surety will not lend against. */
  intangibleAndRelatedPartyCents: Cents;
  /** Revenue over the trailing period the ratios are measured on. */
  revenueCents: Cents;
  /** Open accounts receivable, retainage EXCLUDED (it is not past due). */
  arCents: Cents;
  /** Costs and earnings in excess of billings, across open contracts. */
  underbilledCents: Cents;
  /** Days in the revenue period, for days-in-AR. */
  periodDays: number;
}

export interface SuretyRatios {
  workingCapitalCents: number;
  /** Current assets ÷ current liabilities, in bps. 15000 = 1.5×. */
  currentRatioBps: number | null;
  /** Total liabilities ÷ equity, in bps. Underwriters get nervous past ~3×. */
  debtToEquityBps: number | null;
  tangibleNetWorthCents: number;
  /** Revenue ÷ working capital, in bps. High means OVERTRADING — growing
   *  faster than the balance sheet can carry. */
  revenueToWorkingCapitalBps: number | null;
  daysInAr: number | null;
  /** Underbillings ÷ equity, in bps. Underbillings are a SOFT asset — they
   *  depend on an estimate — so a big number here means the equity an
   *  underwriter is lending against is partly an opinion. */
  underbillingsToEquityBps: number | null;
}

export function computeSuretyRatios(input: SuretyRatioInput): SuretyRatios {
  const ca = assertCents(input.currentAssetsCents);
  const cl = assertCents(input.currentLiabilitiesCents);
  const tl = assertCents(input.totalLiabilitiesCents);
  const equity = input.equityCents;
  const intangible = assertCents(input.intangibleAndRelatedPartyCents);
  const revenue = assertCents(input.revenueCents);
  const ar = assertCents(input.arCents);
  const under = assertCents(input.underbilledCents);
  const workingCapital = ca - cl;

  return {
    workingCapitalCents: workingCapital,
    currentRatioBps: cl === 0 ? null : ratioBps(ca, cl),
    // Negative or zero equity is not "infinite leverage", it is a different
    // conversation entirely — and reporting a number here would imply the
    // ratio still means something.
    debtToEquityBps: equity <= 0 ? null : ratioBps(tl, equity),
    tangibleNetWorthCents: equity - intangible,
    revenueToWorkingCapitalBps:
      workingCapital <= 0 ? null : ratioBps(revenue, workingCapital),
    daysInAr:
      revenue === 0 ? null : Math.round((ar * input.periodDays) / revenue),
    underbillingsToEquityBps: equity <= 0 ? null : ratioBps(under, equity),
  };
}

// ════════════════════════════════════════════════════════════ explainers

/** 4th-grade-plain, figures verbatim. Never AI-written, never computed here. */
export function explainCip(rows: CipRow[]): string {
  if (rows.length === 0) {
    return "You have no open contracts, so there is nothing on this schedule yet.";
  }
  const under = rows.reduce((t, r) => t + r.underbilledCents, 0);
  const over = rows.reduce((t, r) => t + r.overbilledCents, 0);
  const pending = rows.reduce((t, r) => t + r.pendingChangeOrderCents, 0);
  const loss = rows.filter((r) => r.flags.lossJob).length;
  const stale = rows.filter((r) => r.flags.staleEtc).length;

  const parts = [
    `${rows.length} open contract${rows.length === 1 ? "" : "s"}. You have done $${formatMoney(under)} of work you have not billed yet, and customers have paid $${formatMoney(over)} ahead of the work.`,
  ];
  if (pending > 0) {
    parts.push(
      `$${formatMoney(pending)} of change orders are sent but not approved — they are shown separately and are NOT counted in any contract total, which is the first thing a surety checks.`,
    );
  }
  if (loss > 0) {
    parts.push(
      `${loss} job${loss === 1 ? " is" : "s are"} projected to finish at a loss. A surety will ask about ${loss === 1 ? "it" : "each of them"} by name.`,
    );
  }
  if (stale > 0) {
    parts.push(
      `${stale} job${stale === 1 ? "'s" : "s'"} cost-to-finish estimate has not been touched in over a month, so ${stale === 1 ? "its" : "their"} percent complete is only as good as that old guess.`,
    );
  }
  return parts.join(" ");
}

export function explainFade(s: FadeSummary): string {
  if (s.jobsWithBaseline === 0) {
    return "None of your finished jobs has an original budget to compare against, so there is no fade to measure yet. Set a budget when you win a job and this fills in by itself.";
  }
  const dir = s.totalFadeCents < 0 ? "LESS" : "MORE";
  const head = `Across ${s.jobsWithBaseline} finished job${s.jobsWithBaseline === 1 ? "" : "s"}, you made $${formatMoney(Math.abs(s.totalFadeCents))} ${dir} than you expected when you took the work.`;
  const split = `${s.jobsFaded} finished worse than estimated, ${s.jobsImproved} finished better.`;
  const why =
    s.totalFadeCents < 0
      ? "A surety reads that as a reason to discount the profit your open jobs say they will make."
      : "A surety reads that as a reason to believe the profit your open jobs say they will make.";
  return `${head} ${split} ${why}`;
}

export function explainRatios(r: SuretyRatios): string {
  const wc = `Your working capital — what you own that turns to cash within a year, minus what you owe within a year — is $${formatMoney(Math.abs(r.workingCapitalCents))}${r.workingCapitalCents < 0 ? ", and it is NEGATIVE" : ""}.`;
  const cr =
    r.currentRatioBps === null
      ? "You have no short-term debts to compare it against."
      : `For every $1 you owe this year you hold $${(r.currentRatioBps / 10_000).toFixed(2)}.`;
  const tnw = `Stripping out goodwill and anything owed by the owner, your net worth is $${formatMoney(Math.abs(r.tangibleNetWorthCents))}. That is the number bonding capacity is sized from — the multiple is the underwriter's call, not ours.`;
  const soft =
    r.underbillingsToEquityBps !== null && r.underbillingsToEquityBps > 3_000
      ? " A large share of your net worth is unbilled work, which depends on your own cost estimates — expect questions about it."
      : "";
  return `${wc} ${cr} ${tnw}${soft}`;
}

/** Signed ratio in basis points, half-up, sign preserved. */
function ratioBps(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  const sign = numerator < 0 !== denominator < 0 ? -1 : 1;
  return sign * mulDivHalfUp(Math.abs(numerator), 10_000, Math.abs(denominator));
}
