// Moving-average cost — pure, integer cents, half-up. The single costing
// method for stock (simple, CPA-standard for small contractors, no
// lot-tracking ceremony).
import { mulDivHalfUp } from "@/lib/money/cents";

/**
 * New average after a receipt. avg' = (qtyOld*avgOld + qtyIn*costIn) /
 * (qtyOld + qtyIn), all in x100 quantities and cent costs, half-up.
 */
export function receiptAverage(
  qtyOldX100: number,
  avgOldCents: number,
  qtyInX100: number,
  costInCents: number,
): number {
  if (qtyInX100 <= 0) throw new Error("receipt_qty_must_be_positive");
  if (qtyOldX100 < 0 || avgOldCents < 0 || costInCents < 0) {
    throw new Error("negative_inventory_inputs");
  }
  const totalQty = qtyOldX100 + qtyInX100;
  // value in cent·x100 units cancels: (old value + in value) / total qty
  return mulDivHalfUp(
    qtyOldX100 * avgOldCents + qtyInX100 * costInCents,
    1,
    totalQty,
  );
}

/** Extended value of a quantity at a unit cost (x100 qty → cents). */
export function extendedCents(qtyX100: number, unitCostCents: number): number {
  return mulDivHalfUp(unitCostCents, qtyX100, 100);
}
