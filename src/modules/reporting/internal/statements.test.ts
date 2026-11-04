import { describe, expect, it } from "vitest";
import {
  buildBalanceSheet,
  buildCashFlow,
  buildProfitAndLoss,
  buildTrialBalance,
  type AccountBalance,
} from "./statements";

// Golden fixture: a generic small contractor after one clean money loop.
// Debit-positive cents; must tie (Σ = 0).
const FIXTURE: AccountBalance[] = [
  { code: "1020", name: "Cash, general", type: "asset", balanceCents: 843_776 },
  { code: "1210", name: "Accounts receivable, trade", type: "asset", balanceCents: 0 },
  { code: "1290", name: "Retentions receivable", type: "asset", balanceCents: 100_000 },
  { code: "1430", name: "Direct construction cost", type: "asset", balanceCents: 149_725 },
  { code: "2350", name: "Sales tax payable", type: "liability", balanceCents: -50_000 },
  { code: "2960", name: "Draws", type: "equity", balanceCents: 1_599 },
  { code: "3100", name: "Sales", type: "revenue", balanceCents: -1_000_000 },
  { code: "3810", name: "Cost of sales, labor", type: "cogs", balanceCents: 40_000 },
  { code: "6210", name: "Rent, sales office", type: "expense", balanceCents: 5_000 },
  { code: "9900", name: "Unused account", type: "expense", balanceCents: 0 },
  // plug so the fixture ties exactly
  { code: "2990", name: "Other equity", type: "equity", balanceCents: -90_100 },
];

describe("buildProfitAndLoss", () => {
  const pnl = buildProfitAndLoss(FIXTURE);
  it("revenue is credit-positive", () => {
    expect(pnl.revenueCents).toBe(1_000_000);
  });
  it("gross profit = revenue - cogs", () => {
    expect(pnl.costOfSalesCents).toBe(40_000);
    expect(pnl.grossProfitCents).toBe(960_000);
  });
  it("net income = gross profit - expenses", () => {
    expect(pnl.expensesCents).toBe(5_000);
    expect(pnl.netIncomeCents).toBe(955_000);
  });
  it("zero-balance accounts are dropped", () => {
    expect(pnl.expenses.find((l) => l.code === "9900")).toBeUndefined();
  });
  it("explains in plain language with verbatim figures", () => {
    expect(pnl.explain).toBe(
      "You sold $10,000.00 of work. After the cost of doing the jobs and running the business, you kept $9,550.00. That is your profit for this period.",
    );
  });
  it("loss wording when net income is negative", () => {
    const loss = buildProfitAndLoss([
      { code: "3100", name: "Sales", type: "revenue", balanceCents: -10_000 },
      { code: "3810", name: "COGS", type: "cogs", balanceCents: 25_000 },
    ]);
    expect(loss.netIncomeCents).toBe(-15_000);
    expect(loss.explain).toContain("You lost $150.00");
  });
});

describe("buildBalanceSheet", () => {
  const bs = buildBalanceSheet(FIXTURE);
  it("assets are debit-positive", () => {
    expect(bs.assetsCents).toBe(843_776 + 100_000 + 149_725);
  });
  it("liabilities and equity are credit-positive", () => {
    expect(bs.liabilitiesCents).toBe(50_000);
  });
  it("current earnings plug equity and the sheet ties", () => {
    expect(bs.currentEarningsCents).toBe(955_000);
    expect(bs.equityCents).toBe(-1_599 + 90_100 + 955_000);
    expect(bs.liabilitiesAndEquityCents).toBe(bs.assetsCents);
    expect(bs.ties).toBe(true);
  });
  it("a non-tying ledger is reported, never hidden", () => {
    const broken = buildBalanceSheet([
      { code: "1020", name: "Cash", type: "asset", balanceCents: 100 },
    ]);
    expect(broken.ties).toBe(false);
  });
});

describe("buildCashFlow", () => {
  it("buckets by counter-account type and nets the change", () => {
    const cf = buildCashFlow([
      { cashDeltaCents: 900_000, counterType: "asset" }, // AR collection
      { cashDeltaCents: -50_525, counterType: "cogs" }, // job materials
      { cashDeltaCents: -5_000, counterType: "expense" }, // rent
      { cashDeltaCents: -1_599, counterType: "equity" }, // owner draw
    ]);
    expect(cf.fromCustomersCents).toBe(900_000);
    expect(cf.forJobsCents).toBe(-50_525);
    expect(cf.forOverheadCents).toBe(-5_000);
    expect(cf.ownerCents).toBe(-1_599);
    expect(cf.netChangeCents).toBe(842_876);
    expect(cf.explain).toBe(
      "Cash went up by $8,428.76 this period. $9,000.00 came in from customers; $505.25 went out for job costs and $50.00 for running the business.",
    );
  });
  it("down wording when cash shrinks", () => {
    const cf = buildCashFlow([{ cashDeltaCents: -100, counterType: "expense" }]);
    expect(cf.explain).toContain("Cash went down by $1.00");
  });
});

describe("buildTrialBalance", () => {
  it("ties on the golden fixture and drops zero rows", () => {
    const tb = buildTrialBalance(FIXTURE);
    expect(tb.ties).toBe(true);
    expect(tb.totalDebitsCents).toBe(tb.totalCreditsCents);
    expect(tb.rows.find((r) => r.code === "1210")).toBeUndefined();
    expect(tb.explain).toContain("Your books balance.");
  });
  it("warns loudly when the ledger does not tie", () => {
    const tb = buildTrialBalance([
      { code: "1020", name: "Cash", type: "asset", balanceCents: 100 },
    ]);
    expect(tb.ties).toBe(false);
    expect(tb.explain).toContain("Something is wrong");
  });
});
