import { describe, expect, it } from "vitest";
import { BILL_PAY_ACCOUNTS, billPayEntryLines, type BillPayStep } from "./bill-pay";

const { AP, CASH, IN_TRANSIT } = BILL_PAY_ACCOUNTS;

/** Net movement per account across a sequence of steps. Debit positive. */
function net(steps: BillPayStep[], amountCents: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of steps) {
    for (const l of billPayEntryLines(s, amountCents)) {
      out[l.accountCode] =
        (out[l.accountCode] ?? 0) + (l.debitCents ?? 0) - (l.creditCents ?? 0);
    }
  }
  return out;
}

describe("bill-pay postings", () => {
  const AMT = 185000;

  it("every individual entry balances", () => {
    for (const step of ["submitted", "settled", "returned"] as const) {
      const lines = billPayEntryLines(step, AMT);
      const dr = lines.reduce((s, l) => s + (l.debitCents ?? 0), 0);
      const cr = lines.reduce((s, l) => s + (l.creditCents ?? 0), 0);
      expect(dr, step).toBe(cr);
      expect(dr, step).toBe(AMT);
    }
  });

  /**
   * The whole point of the clearing account: while a payment is in flight,
   * cash has NOT moved. Crediting cash at submission would make the bank
   * reconciliation impossible for the 1-3 days until it settles.
   */
  it("does not touch cash until settlement", () => {
    const submitted = net(["submitted"], AMT);
    expect(submitted[CASH] ?? 0).toBe(0);
    expect(submitted[AP]).toBe(AMT); // debit — no longer payable
    expect(submitted[IN_TRANSIT]).toBe(-AMT); // credit — owed to the rail
  });

  it("submit then settle lands exactly where a manual payment lands", () => {
    const n = net(["submitted", "settled"], AMT);
    expect(n[AP]).toBe(AMT); // DR accounts payable
    expect(n[CASH]).toBe(-AMT); // CR cash
    expect(n[IN_TRANSIT]).toBe(0); // clearing account fully cleared
  });

  /**
   * A returned payment must leave the books EXACTLY as they were — the vendor
   * owed again, no cash movement, nothing stuck in the clearing account. If
   * this drifts, a bounced payment silently writes off a debt the shop still
   * owes, and the supplier is the one who finds out.
   */
  it("submit then return is a complete no-op", () => {
    const n = net(["submitted", "returned"], AMT);
    expect(n[AP] ?? 0).toBe(0);
    expect(n[CASH] ?? 0).toBe(0);
    expect(n[IN_TRANSIT] ?? 0).toBe(0);
  });

  it("a retried payment after a return still settles correctly", () => {
    const n = net(["submitted", "returned", "submitted", "settled"], AMT);
    expect(n[AP]).toBe(AMT);
    expect(n[CASH]).toBe(-AMT);
    expect(n[IN_TRANSIT] ?? 0).toBe(0);
  });

  it("uses the clearing account, never cash-to-AP directly", () => {
    // Guards the specific mistake this design exists to prevent.
    const submitted = billPayEntryLines("submitted", AMT);
    expect(submitted.map((l) => l.accountCode)).toEqual([AP, IN_TRANSIT]);
    expect(submitted.some((l) => l.accountCode === CASH)).toBe(false);
  });
});
