// Contract movement math — pure, integer cents, no I/O.
//
// A job's contract price is the SUM of its movements: the original award plus
// one signed delta per approved change order. Everything downstream (WIP
// percent-complete, earned revenue, over/under-billing) reads that sum, so it
// is worth being exactly right and worth being testable without a database.

import { mulDivHalfUp } from "@/lib/money/cents";

export interface ChangeOrderLineInput {
  description: string;
  /** Quantity ×100, so 1.5 units is 150. Matches estimate_lines. */
  qtyX100: number;
  /** SIGNED. Negative on a deduct — credit for work removed from the job. */
  unitPriceCents: number;
}

export interface ContractMovement {
  seq: number;
  kind: "award" | "change-order" | "correction";
  deltaCents: number;
}

export interface ContractSummary {
  originalCents: number;
  addedCents: number;
  deductedCents: number;
  /** What the contract is now — the number every other module reads. */
  currentCents: number;
  changeOrderCount: number;
  /** Change as a share of the original, in bps. 0 when there is no original. */
  changeBps: number;
}

/**
 * One change-order line's total. Same rule as `lineTotalCents` in estimating,
 * and it must stay the same rule: a change order priced differently from the
 * estimate it amends is a support ticket.
 *
 * `mulDivHalfUp` carries the sign correctly, which is what makes a deduct line
 * work without a special case.
 */
export function changeOrderLineTotal(qtyX100: number, unitPriceCents: number): number {
  return mulDivHalfUp(unitPriceCents, qtyX100, 100);
}

export function changeOrderTotalCents(lines: ChangeOrderLineInput[]): number {
  return lines.reduce((sum, l) => sum + changeOrderLineTotal(l.qtyX100, l.unitPriceCents), 0);
}

export function summarizeContract(movements: ContractMovement[]): ContractSummary {
  const award = movements.find((m) => m.kind === "award");
  const originalCents = award?.deltaCents ?? 0;
  const changes = movements.filter((m) => m.kind !== "award");
  const addedCents = changes.filter((m) => m.deltaCents > 0).reduce((s, m) => s + m.deltaCents, 0);
  // Reported POSITIVE. "Deducted $4,200" reads correctly; "deducted -$4,200"
  // makes an owner do arithmetic to find out which way the money went.
  const deductedCents = -changes
    .filter((m) => m.deltaCents < 0)
    .reduce((s, m) => s + m.deltaCents, 0);
  const currentCents = movements.reduce((s, m) => s + m.deltaCents, 0);
  return {
    originalCents,
    addedCents,
    deductedCents,
    currentCents,
    changeOrderCount: changes.length,
    changeBps:
      originalCents === 0 ? 0 : mulDivHalfUp(currentCents - originalCents, 10_000, originalCents),
  };
}

/**
 * Plain-English contract history. Deterministic template, figures verbatim —
 * the house rule for every money module.
 */
export function explainContract(s: ContractSummary, money: (c: number) => string): string {
  if (s.changeOrderCount === 0) {
    return `This job is contracted at ${money(s.currentCents)}, with no change orders.`;
  }
  const parts: string[] = [`You started at ${money(s.originalCents)}`];
  if (s.addedCents > 0) parts.push(`added ${money(s.addedCents)} of work`);
  if (s.deductedCents > 0) parts.push(`took ${money(s.deductedCents)} back off`);
  const pct = Math.abs(Math.round(s.changeBps / 100));
  const direction = s.currentCents >= s.originalCents ? "up" : "down";
  return (
    `${parts.join(", ")}, so the contract is now ${money(s.currentCents)} — ` +
    `${pct}% ${direction} across ${s.changeOrderCount} change order${s.changeOrderCount === 1 ? "" : "s"}.`
  );
}

/**
 * Is this change order allowed to be approved?
 *
 * A deduct that would drive the contract negative is a DOMAIN error, caught
 * here with a sentence a person can act on. Without this it reaches the
 * `contract_cents >= 0` CHECK and surfaces as a raw 23514, which tells the
 * office nothing and the customer less.
 */
export function checkChangeOrder(
  currentContractCents: number,
  deltaCents: number,
): { ok: true } | { ok: false; code: string } {
  if (deltaCents === 0) return { ok: false, code: "change_order_is_zero" };
  if (currentContractCents + deltaCents < 0) return { ok: false, code: "deduct_exceeds_contract" };
  return { ok: true };
}
