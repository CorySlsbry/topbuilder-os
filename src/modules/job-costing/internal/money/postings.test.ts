import { describe, expect, it } from "vitest";
import { validateEntry } from "@/modules/ledger";
import { computeTax } from "./tax";
import { splitRetainage } from "./retainage";
import { JobCostError } from "./wip";
import {
  postCostCaptured,
  postDepositEarned,
  postFinancedFunding,
  postInsuranceAcvReceived,
  postInvoiceIssued,
  postPaymentReceived,
  type PostingAccounts,
} from "./postings";

const A: PostingAccounts = {
  cash: "1020",
  ar: "1210",
  retainageReceivable: "1290",
  revenue: "3100",
  taxPayable: "2210",
  customerDeposits: "2100",
  dealerFeeCost: "5600",
  jobCost: "5200",
  ap: "2010",
};

const ON = "2026-07-01";

// Every posting rule must produce an entry the LEDGER's own validator accepts
// (balanced, one-sided lines, >= 2 lines) — the rules and the ledger agree.
function balanced(e: ReturnType<typeof postPaymentReceived>): void {
  expect(() => validateEntry(e)).not.toThrow();
}

describe("posting rules → balanced journal entries", () => {
  it("invoice with sales tax + 10% retainage: AR + retainage = revenue + tax", () => {
    const revenue = 1_000_000; // $10,000 pre-tax
    const tax = computeTax({ method: "retail", stateBps: 600 }, { invoiceCents: revenue });
    const total = revenue + tax.totalTaxCents; // 1,060,000
    const ret = splitRetainage(total, 1000); // 10% held
    const e = postInvoiceIssued({
      occurredOn: ON,
      accounts: A,
      revenueCents: revenue,
      tax,
      retainage: ret,
      dims: { jobId: "job-1", class: "roofing" },
    });
    balanced(e);
    expect(e.lines).toContainEqual(
      expect.objectContaining({ accountCode: "1210", debitCents: 954_000 }),
    );
    expect(e.lines).toContainEqual(
      expect.objectContaining({ accountCode: "1290", debitCents: 106_000 }),
    );
    expect(e.lines).toContainEqual(
      expect.objectContaining({ accountCode: "3100", creditCents: 1_000_000 }),
    );
    // tax goes to the liability, never revenue
    expect(e.lines).toContainEqual(
      expect.objectContaining({ accountCode: "2210", creditCents: 60_000 }),
    );
  });

  it("rejects a retainage split that doesn't cover the invoice total", () => {
    const tax = computeTax({ method: "none" }, { invoiceCents: 1000 });
    expect(() =>
      postInvoiceIssued({
        occurredOn: ON,
        accounts: A,
        revenueCents: 1000,
        tax,
        retainage: { dueNowCents: 900, retainageCents: 50 }, // 950 ≠ 1000
      }),
    ).toThrow(JobCostError);
  });

  it("payment: DR cash / CR AR", () => {
    const e = postPaymentReceived({ occurredOn: ON, accounts: A, amountCents: 954_000 });
    balanced(e);
    expect(e.lines).toEqual([
      { accountCode: "1020", debitCents: 954_000 },
      { accountCode: "1210", creditCents: 954_000 },
    ]);
  });

  it("cost capture REQUIRES job + cost-code dimensions", () => {
    const e = postCostCaptured({
      occurredOn: ON,
      accounts: A,
      amountCents: 84_200,
      paidFrom: "ap",
      dims: { jobId: "job-1", costCode: "4100" },
    });
    balanced(e);
    expect(e.lines[0]).toMatchObject({
      accountCode: "5200",
      debitCents: 84_200,
      jobId: "job-1",
      costCode: "4100",
    });
    expect(e.lines[1]).toMatchObject({ accountCode: "2010", creditCents: 84_200 });
  });

  it("insurance ACV is a DEPOSIT (liability), not revenue — until earned", () => {
    const acv = postInsuranceAcvReceived({
      occurredOn: ON,
      accounts: A,
      amountCents: 1_500_000,
    });
    balanced(acv);
    expect(acv.lines).toContainEqual(
      expect.objectContaining({ accountCode: "2100", creditCents: 1_500_000 }),
    );
    const earned = postDepositEarned({
      occurredOn: "2026-08-15",
      accounts: A,
      amountCents: 1_500_000,
    });
    balanced(earned);
    expect(earned.lines).toContainEqual(
      expect.objectContaining({ accountCode: "3100", creditCents: 1_500_000 }),
    );
  });

  it("financed funding: gross revenue, dealer fee as a cost (never netted)", () => {
    // $30,000 gross, $6,000 dealer fee → $24,000 wired
    const e = postFinancedFunding({
      occurredOn: ON,
      accounts: A,
      grossContractCents: 3_000_000,
      dealerFeeCents: 600_000,
    });
    balanced(e);
    expect(e.lines).toContainEqual(
      expect.objectContaining({ accountCode: "1020", debitCents: 2_400_000 }),
    );
    expect(e.lines).toContainEqual(
      expect.objectContaining({ accountCode: "5600", debitCents: 600_000 }),
    );
    expect(e.lines).toContainEqual(
      expect.objectContaining({ accountCode: "3100", creditCents: 3_000_000 }),
    );
  });

  it("dealer fee >= gross is a data bug, rejected", () => {
    expect(() =>
      postFinancedFunding({
        occurredOn: ON,
        accounts: A,
        grossContractCents: 1000,
        dealerFeeCents: 1000,
      }),
    ).toThrow(JobCostError);
  });
});
