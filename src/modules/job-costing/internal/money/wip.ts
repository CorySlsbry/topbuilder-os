// WIP / percentage-of-completion — the cost-to-cost input method (the measure
// CPAs use for POC revenue recognition). Pure, integer cents, deterministic.
//
// pctComplete = costsToDate / (costsToDate + estCostToComplete)
// earnedRevenue = contract × pctComplete   (capped at contract)
// underbilled (asset, "costs in excess of billings")  = max(0, earned − billed)
// overbilled  (liability, "billings in excess")       = max(0, billed − earned)
// A job sits in EXACTLY one bucket; portfolio sums are NEVER netted.
import { assertCents, formatMoney, mulDivHalfUp, type Cents } from "@/lib/money/cents";
import { HttpError } from "@/lib/http/errors";

export class JobCostError extends HttpError {
  constructor(code: string) {
    super(422, code);
  }
}

export interface WipInput {
  /** Contract price including APPROVED change orders only. */
  contractCents: Cents;
  costsToDateCents: Cents;
  /** The owner/PM's estimate to complete — the input only they can supply. */
  estCostToCompleteCents: Cents;
  billedToDateCents: Cents;
  /** Days since the estimate-to-complete was last reviewed (staleness). */
  etcAgeDays?: number;
}

export interface WipResult {
  estTotalCostCents: Cents;
  /** Percent complete in basis points (0..10000) — never a float. */
  pctCompleteBps: number;
  earnedRevenueCents: Cents;
  grossProfitCents: Cents; // earned − costs to date (can be negative)
  underbilledCents: Cents; // "costs in excess of billings" — asset
  overbilledCents: Cents; // "billings in excess of costs" — liability
  flags: {
    zeroEstimate: boolean;
    billedPastContract: boolean;
    staleEtc: boolean;
    lossJob: boolean; // projected loss: est total cost > contract
  };
}

const STALE_ETC_DAYS = 30;

export function computeWip(input: WipInput): WipResult {
  const contract = assertCents(input.contractCents);
  const costs = assertCents(input.costsToDateCents);
  const etc = assertCents(input.estCostToCompleteCents);
  const billed = assertCents(input.billedToDateCents);
  if (contract < 0 || costs < 0 || etc < 0 || billed < 0) {
    throw new JobCostError("wip_inputs_must_be_nonnegative");
  }

  const estTotal = costs + etc;
  // Guard: estTotal = 0 with no costs → 0% complete, never NaN/Infinity.
  const pctBps = estTotal === 0 ? 0 : mulDivHalfUp(costs, 10_000, estTotal);
  // Earned from the raw ratio (not the rounded bps) for cent precision.
  const earnedRaw = estTotal === 0 ? 0 : mulDivHalfUp(contract, costs, estTotal);
  const earned = Math.min(earnedRaw, contract);

  return {
    estTotalCostCents: estTotal,
    pctCompleteBps: pctBps,
    earnedRevenueCents: earned,
    grossProfitCents: earned - costs,
    underbilledCents: Math.max(0, earned - billed),
    overbilledCents: Math.max(0, billed - earned),
    flags: {
      zeroEstimate: estTotal === 0,
      billedPastContract: billed > contract,
      staleEtc: costs > 0 && (input.etcAgeDays ?? 0) > STALE_ETC_DAYS,
      lossJob: estTotal > contract && contract > 0,
    },
  };
}

/** 4th-grade-plain explanation. Figures verbatim from the result — no math here. */
export function explainWip(r: WipResult): string {
  const pct = Math.round(r.pctCompleteBps / 100);
  if (r.flags.zeroEstimate) {
    return "This job has no cost estimate yet, so we can't tell how far along it is. Add a budget to see the picture.";
  }
  if (r.overbilledCents > 0) {
    return `You've finished about ${pct}% of the work and billed AHEAD of it — customers have paid $${formatMoney(r.overbilledCents)} for work you haven't done yet. Good for cash, but that money is still owed as work.`;
  }
  if (r.underbilledCents > 0) {
    return `You've finished about ${pct}% of the work but haven't billed for all of it — you can bill $${formatMoney(r.underbilledCents)} more right now for work you already did.`;
  }
  return `You've finished about ${pct}% of the work and your billing matches it. Right on track.`;
}

/**
 * The same sentence for the WHOLE portfolio, because the WIP screen shows a
 * table of jobs and a row of totals — and the totals are the part an owner
 * reads first.
 *
 * Under and over are reported SEPARATELY and never netted. Netting them is the
 * classic WIP mistake: $40k underbilled on one job and $40k overbilled on
 * another is not "fine" — it is one invoice you forgot to send and one customer
 * who has paid for work you still owe.
 */
export function explainWipPortfolio(t: {
  underbilledCents: number;
  overbilledCents: number;
  contractCents: number;
  costsCents: number;
  earnedCents: number;
  billedCents: number;
}): string {
  if (t.contractCents === 0) {
    return "There are no open jobs with a contract yet, so there's nothing to report here.";
  }
  const parts: string[] = [];
  if (t.underbilledCents > 0) {
    parts.push(
      `Across your open jobs you've done $${formatMoney(t.underbilledCents)} of work you haven't invoiced yet — that's money you can bill today.`,
    );
  }
  if (t.overbilledCents > 0) {
    parts.push(
      `Customers have paid $${formatMoney(t.overbilledCents)} ahead for work that isn't finished, so plan on doing that work before that cash is really yours.`,
    );
  }
  if (parts.length === 0) {
    parts.push("Across your open jobs, your billing lines up with the work you've done. Nothing to chase.");
  }
  parts.push(
    `In total you're holding $${formatMoney(t.contractCents)} of contracts, you've spent $${formatMoney(t.costsCents)}, and you've billed $${formatMoney(t.billedCents)}.`,
  );
  return parts.join(" ");
}
