// Retainage — the slice of each invoice/bill held back until the job is done.
// Receivable retainage (they hold ours) and payable retainage (we hold the
// sub's) live in their own accounts, are NEVER netted, and age separately so
// AR/AP are never silently wrong. Pure, integer cents.
import { assertCents, formatMoney, mulDivHalfUp, type Cents } from "@/lib/money/cents";
import { JobCostError } from "./wip";

export interface RetainageSplit {
  /** The amount due now (invoice minus held retainage). */
  dueNowCents: Cents;
  /** The amount held as retainage (receivable 12xx / payable 21xx side). */
  retainageCents: Cents;
}

/** Split an invoice (or sub bill) at a retainage rate given in basis points. */
export function splitRetainage(amountCents: Cents, rateBps: number): RetainageSplit {
  const amount = assertCents(amountCents);
  if (amount < 0) throw new JobCostError("retainage_amount_must_be_nonnegative");
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 5000) {
    // >50% retainage is a data-entry error in any real contract.
    throw new JobCostError("retainage_rate_out_of_range");
  }
  const retainage = mulDivHalfUp(amount, rateBps, 10_000);
  return { dueNowCents: amount - retainage, retainageCents: retainage };
}

export interface RetainageRelease {
  releasedCents: Cents;
  remainingHeldCents: Cents;
}

/** Release retainage (moves held balance to current AR/AP — never nets). */
export function releaseRetainage(
  heldCents: Cents,
  releaseCents: Cents,
): RetainageRelease {
  const held = assertCents(heldCents);
  const rel = assertCents(releaseCents);
  if (rel < 0 || held < 0) throw new JobCostError("retainage_amounts_must_be_nonnegative");
  if (rel > held) throw new JobCostError("cannot_release_more_than_held");
  return { releasedCents: rel, remainingHeldCents: held - rel };
}

export function explainRetainage(s: RetainageSplit): string {
  if (s.retainageCents === 0) {
    return "No money is being held back on this bill — the full amount is due now.";
  }
  return `$${formatMoney(s.dueNowCents)} is due now. $${formatMoney(s.retainageCents)} is held back until the job is finished — don't forget to bill for it at the end, or you lose it.`;
}
