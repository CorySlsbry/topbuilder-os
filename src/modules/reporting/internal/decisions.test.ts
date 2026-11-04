import { describe, expect, it } from "vitest";
import { buildDecisions, nothingToDecide, type DecisionFacts } from "./decisions";

/**
 * The decision list is the first thing an owner reads and usually the only
 * thing. If the ranking is wrong the expensive problem is below the fold,
 * which is the same as not reporting it.
 */

const empty: DecisionFacts = {
  underbilled: [],
  lateInvoices: [],
  lateBills: [],
  overdueRetainage: [],
  cashLow: null,
  lossJobs: [],
  staleEtc: [],
  unansweredBankLines: 0,
  completedNotInvoiced: [],
};

describe("what needs a decision", () => {
  it("⛔ ranks by MONEY AT STAKE, not by category", () => {
    // The owner reads three lines and stops. If a $900 late bill outranks a
    // $40,000 unbilled invoice because bills happen to be checked first,
    // the list is worse than useless — it is misleading.
    const d = buildDecisions({
      ...empty,
      lateBills: [{ billId: "b", vendorName: "Ferguson", cents: 90_000, daysLate: 12 }],
      underbilled: [{ jobId: "j", jobNo: 7, name: "Nguyen re-roof", cents: 4_000_000 }],
    });
    expect(d[0]!.text).toContain("Nguyen");
    expect(d[1]!.text).toContain("Ferguson");
  });

  it("puts a NAME and a NUMBER in every sentence", () => {
    const d = buildDecisions({
      ...empty,
      lateInvoices: [
        { invoiceId: "i", invoiceNo: 1025, customerName: "Reyes Development", cents: 4_280_000, daysLate: 42 },
      ],
    });
    expect(d[0]!.text).toContain("Reyes Development");
    expect(d[0]!.text).toContain("$42,800.00");
    expect(d[0]!.text).toContain("42 days");
  });

  it("weights a cash dip by the SHORTFALL, not the balance", () => {
    // A $2k dip below the floor must not outrank a $40k unbilled invoice
    // just because the cash balance is a big number.
    const d = buildDecisions({
      ...empty,
      cashLow: { weekLabel: "week 6", cents: 148_000_00, floorCents: 150_000_00 },
      underbilled: [{ jobId: "j", jobNo: 3, name: "Alvarez", cents: 40_000_00 }],
    });
    expect(d[0]!.text).toContain("Alvarez");
  });

  it("says nothing about cash when it never goes under the floor", () => {
    const d = buildDecisions({
      ...empty,
      cashLow: { weekLabel: "week 9", cents: 200_000_00, floorCents: 150_000_00 },
    });
    expect(d).toEqual([]);
  });

  it("⛔ keeps advisories BELOW anything with money on it", () => {
    // "You cannot reconcile" matters, but never more than an invoice nobody
    // sent. Advisories carry zero weight on purpose.
    const d = buildDecisions({
      ...empty,
      unansweredBankLines: 14,
      staleEtc: [{ jobId: "j", jobNo: 2, name: "Ortiz", days: 61 }],
      underbilled: [{ jobId: "k", jobNo: 5, name: "Chen", cents: 1_00 }],
    });
    expect(d[0]!.text).toContain("Chen");
  });

  it("marks a badly late invoice urgent and a fresh one not", () => {
    const fresh = buildDecisions({
      ...empty,
      lateInvoices: [{ invoiceId: "i", invoiceNo: 1, customerName: "A", cents: 100_00, daysLate: 3 }],
    });
    const old = buildDecisions({
      ...empty,
      lateInvoices: [{ invoiceId: "i", invoiceNo: 1, customerName: "A", cents: 100_00, daysLate: 44 }],
    });
    expect(fresh[0]!.urgent).toBeFalsy();
    expect(old[0]!.urgent).toBe(true);
  });

  it("names the lien risk on a late bill, because that is the real stake", () => {
    const d = buildDecisions({
      ...empty,
      lateBills: [{ billId: "b", vendorName: "Summit Framing", cents: 68_400_00, daysLate: 11 }],
    });
    expect(d[0]!.text).toContain("lien");
  });

  it("caps the list, because a list of twenty is a list of none", () => {
    const many = buildDecisions({
      ...empty,
      underbilled: Array.from({ length: 30 }, (_, i) => ({
        jobId: `j${i}`, jobNo: i, name: `Job ${i}`, cents: (i + 1) * 1000_00,
      })),
    });
    expect(many).toHaveLength(6);
    // And the biggest is first.
    expect(many[0]!.text).toContain("Job 29");
  });

  it("flags a finished job with no invoice even though it has no dollar figure", () => {
    // The missing number IS the problem. It must not fall off the list for
    // failing to have one.
    const d = buildDecisions({
      ...empty,
      completedNotInvoiced: [{ jobId: "j", jobNo: 9, name: "Halvorsen" }],
    });
    expect(d[0]!.text).toContain("Halvorsen");
    expect(d[0]!.text).toContain("no invoice");
  });

  it("⛔ an empty list reads as an achievement, not a broken query", () => {
    expect(buildDecisions(empty)).toEqual([]);
    expect(nothingToDecide(empty)).toContain("good week");
  });

  it("is honest when the picture is incomplete", () => {
    // A clean list drawn from unreconciled books is not a clean week, and
    // saying so is the difference between a report and a reassurance.
    expect(nothingToDecide({ ...empty, unansweredBankLines: 6 })).toContain("incomplete");
  });
});
