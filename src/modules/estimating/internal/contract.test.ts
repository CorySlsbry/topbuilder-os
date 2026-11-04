import { describe, expect, it } from "vitest";
import {
  changeOrderLineTotal,
  changeOrderTotalCents,
  checkChangeOrder,
  explainContract,
  summarizeContract,
  type ContractMovement,
} from "./contract";

const money = (c: number) =>
  (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

describe("changeOrderLineTotal", () => {
  it("multiplies qty×100 by unit price, half-up", () => {
    expect(changeOrderLineTotal(100, 45_000)).toBe(45_000); // 1 × $450
    expect(changeOrderLineTotal(250, 12_000)).toBe(30_000); // 2.5 × $120
  });

  it("carries the sign on a DEDUCT without a special case", () => {
    // A deduct is a negative unit price, not a separate code path. This is the
    // whole reason the shared half-up helper is used instead of Math.round.
    expect(changeOrderLineTotal(100, -45_000)).toBe(-45_000);
    expect(changeOrderLineTotal(150, -20_000)).toBe(-30_000);
  });

  it("rounds half-up at the cent, in both directions", () => {
    // 0.005 × $1.00 → 0.5c. Half-up means away from zero on both sides, so a
    // deduct and an add of the same magnitude stay symmetrical — otherwise a
    // credit and its reversal do not cancel.
    expect(changeOrderLineTotal(50, 1)).toBe(1);
    expect(changeOrderLineTotal(50, -1)).toBe(-1);
  });
});

describe("changeOrderTotalCents", () => {
  it("sums mixed adds and deducts", () => {
    expect(
      changeOrderTotalCents([
        { description: "Extra return duct", qtyX100: 100, unitPriceCents: 68_000 },
        { description: "Remove attic unit from scope", qtyX100: 100, unitPriceCents: -95_000 },
      ]),
    ).toBe(-27_000);
  });
  it("no lines is zero", () => {
    expect(changeOrderTotalCents([])).toBe(0);
  });
});

describe("summarizeContract", () => {
  const movements: ContractMovement[] = [
    { seq: 1, kind: "award", deltaCents: 985_000 },
    { seq: 2, kind: "change-order", deltaCents: 68_000 },
    { seq: 3, kind: "change-order", deltaCents: -95_000 },
    { seq: 4, kind: "change-order", deltaCents: 120_000 },
  ];

  it("adds up to the current contract", () => {
    expect(summarizeContract(movements).currentCents).toBe(1_078_000);
  });

  it("reports adds and deducts separately, and deducts POSITIVE", () => {
    const s = summarizeContract(movements);
    expect(s.originalCents).toBe(985_000);
    expect(s.addedCents).toBe(188_000);
    // "Deducted $950" reads right; "deducted -$950" makes an owner do the
    // arithmetic to work out which way the money went.
    expect(s.deductedCents).toBe(95_000);
    expect(s.changeOrderCount).toBe(3);
  });

  it("change is measured against the ORIGINAL, not the running total", () => {
    // 1,078,000 vs 985,000 = +9.44% -> 944 bps.
    expect(summarizeContract(movements).changeBps).toBe(944);
  });

  it("an award with no changes is a flat contract", () => {
    const s = summarizeContract([{ seq: 1, kind: "award", deltaCents: 500_000 }]);
    expect(s).toMatchObject({ currentCents: 500_000, changeOrderCount: 0, changeBps: 0 });
  });

  it("no award (a job priced at zero) does not divide by zero", () => {
    const s = summarizeContract([{ seq: 1, kind: "change-order", deltaCents: 10_000 }]);
    expect(s.changeBps).toBe(0);
    expect(s.currentCents).toBe(10_000);
  });

  it("a correction counts as a change, not as the award", () => {
    const s = summarizeContract([
      { seq: 1, kind: "award", deltaCents: 100_000 },
      { seq: 2, kind: "correction", deltaCents: -1_000 },
    ]);
    expect(s.originalCents).toBe(100_000);
    expect(s.currentCents).toBe(99_000);
    expect(s.changeOrderCount).toBe(1);
  });
});

describe("explainContract", () => {
  it("says nothing clever when there is nothing to say", () => {
    const s = summarizeContract([{ seq: 1, kind: "award", deltaCents: 985_000 }]);
    expect(explainContract(s, money)).toBe(
      "This job is contracted at $9,850.00, with no change orders.",
    );
  });

  it("names both directions, with every figure verbatim", () => {
    const s = summarizeContract([
      { seq: 1, kind: "award", deltaCents: 985_000 },
      { seq: 2, kind: "change-order", deltaCents: 68_000 },
      { seq: 3, kind: "change-order", deltaCents: -95_000 },
    ]);
    const text = explainContract(s, money);
    expect(text).toContain("$9,850.00");
    expect(text).toContain("added $680.00 of work");
    expect(text).toContain("took $950.00 back off");
    expect(text).toContain("$9,580.00");
    expect(text).toContain("down");
    // Never a minus sign in the prose — the words carry the direction.
    expect(text).not.toContain("-$");
  });

  it("pluralises honestly", () => {
    const one = summarizeContract([
      { seq: 1, kind: "award", deltaCents: 100_000 },
      { seq: 2, kind: "change-order", deltaCents: 10_000 },
    ]);
    expect(explainContract(one, money)).toContain("1 change order.");
  });
});

describe("checkChangeOrder", () => {
  it("allows a normal add and a normal deduct", () => {
    expect(checkChangeOrder(985_000, 68_000).ok).toBe(true);
    expect(checkChangeOrder(985_000, -95_000).ok).toBe(true);
  });

  it("refuses a zero change order", () => {
    const r = checkChangeOrder(985_000, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("change_order_is_zero");
  });

  it("refuses a deduct that would drive the contract negative", () => {
    // Without this the raw `contract_cents >= 0` CHECK fires and the office
    // sees a Postgres 23514, which tells them nothing.
    const r = checkChangeOrder(100_000, -100_001);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("deduct_exceeds_contract");
  });

  it("a deduct to exactly zero is allowed — a cancelled scope is legitimate", () => {
    expect(checkChangeOrder(100_000, -100_000).ok).toBe(true);
  });
});
