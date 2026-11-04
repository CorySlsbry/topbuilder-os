import { describe, expect, it } from "vitest";
import { computeTax, explainTax } from "./tax";
import { splitRetainage, releaseRetainage, explainRetainage } from "./retainage";
import {
  buildPersonalReclass,
  personalDestination,
  suspectPersonal,
  explainPersonal,
} from "./personal";
import { JobCostError } from "./wip";

describe("sales tax — the state-agnostic engine (rates from the tenant's tax profile, never hardcoded)", () => {
  it("no-sales-tax state → zero everywhere", () => {
    const r = computeTax({ method: "none" }, { invoiceCents: 100_000 });
    expect(r.totalTaxCents).toBe(0);
    expect(r.taxableBaseCents).toBe(0);
  });

  it("retail state: full invoice at combined jurisdiction rates", () => {
    // e.g. 6% state + 1% county + 2% city on a $1,000 invoice
    const r = computeTax(
      { method: "retail", stateBps: 600, countyBps: 100, cityBps: 200 },
      { invoiceCents: 100_000 },
    );
    expect(r.taxableBaseCents).toBe(100_000);
    expect(r.stateTaxCents).toBe(6_000);
    expect(r.countyTaxCents).toBe(1_000);
    expect(r.cityTaxCents).toBe(2_000);
    expect(r.totalTaxCents).toBe(9_000);
  });

  it("gross-factor regime (e.g. prime-contracting 65% factor) — the hard case", () => {
    // $30,000 contract, 65% statutory factor, 5.6% state + 0.7% county
    const r = computeTax(
      { method: "gross-factor", factorBps: 6500, stateBps: 560, countyBps: 70 },
      { invoiceCents: 3_000_000 },
    );
    expect(r.taxableBaseCents).toBe(1_950_000);
    expect(r.stateTaxCents).toBe(109_200);
    expect(r.countyTaxCents).toBe(13_650);
    expect(r.totalTaxCents).toBe(122_850);
  });

  it("materials-cost regime (repair/maintenance style): tax on materials only", () => {
    const r = computeTax(
      { method: "materials-cost", cityBps: 260 },
      { invoiceCents: 500_000, materialsCostCents: 40_000 },
    );
    expect(r.taxableBaseCents).toBe(40_000);
    expect(r.totalTaxCents).toBe(1_040);
  });

  it("materials method without materials cost is a typed error", () => {
    expect(() =>
      computeTax({ method: "materials-cost", cityBps: 260 }, { invoiceCents: 1 }),
    ).toThrow(JobCostError);
  });

  it("absurd rates are rejected (data bug, not a tax)", () => {
    expect(() =>
      computeTax({ method: "retail", stateBps: 5000 }, { invoiceCents: 1 }),
    ).toThrow(JobCostError);
  });

  it("explains that the tax money is not theirs", () => {
    const r = computeTax(
      { method: "retail", stateBps: 600 },
      { invoiceCents: 100_000 },
    );
    expect(explainTax(r)).toContain("NOT yours");
  });
});

describe("retainage", () => {
  it("splits an invoice at 10%: bill now vs held", () => {
    const s = splitRetainage(5_000_000, 1000);
    expect(s.dueNowCents).toBe(4_500_000);
    expect(s.retainageCents).toBe(500_000);
    expect(explainRetainage(s)).toContain("held back");
  });

  it("zero rate holds nothing", () => {
    expect(splitRetainage(5_000_000, 0).retainageCents).toBe(0);
  });

  it("releases move held → current and never go negative", () => {
    const r = releaseRetainage(500_000, 200_000);
    expect(r.remainingHeldCents).toBe(300_000);
    expect(() => releaseRetainage(500_000, 600_000)).toThrow(JobCostError);
  });

  it("rejects out-of-range rates", () => {
    expect(() => splitRetainage(1000, 6000)).toThrow(JobCostError);
  });
});

describe("personal-expense handling (CPA-correct, never P&L, never a job)", () => {
  it("destination by entity type", () => {
    expect(personalDestination("sole-prop")).toBe("owner-draws");
    expect(personalDestination("smllc")).toBe("owner-draws");
    expect(personalDestination("partnership")).toBe("owner-draws");
    expect(personalDestination("s-corp")).toBe("due-from-owner");
    expect(personalDestination("c-corp")).toBe("due-from-owner");
  });

  it("builds the reclass entry: DR draws / CR cash, no job dimensions", () => {
    const e = buildPersonalReclass({
      entityType: "smllc",
      amountCents: 21_400,
      occurredOn: "2026-07-01",
      cashAccountCode: "1020",
      drawsAccountCode: "2910",
      dueFromOwnerAccountCode: "1350",
    });
    expect(e.sourceType).toBe("personal-reclass");
    expect(e.lines).toEqual([
      { accountCode: "2910", debitCents: 21_400 },
      { accountCode: "1020", creditCents: 21_400 },
    ]);
    // no jobId / costCode anywhere — it can never leak into job costing
    expect(JSON.stringify(e)).not.toContain("jobId");
  });

  it("corporation routes to due-from-owner instead of draws", () => {
    const e = buildPersonalReclass({
      entityType: "s-corp",
      amountCents: 21_400,
      occurredOn: "2026-07-01",
      cashAccountCode: "1020",
      drawsAccountCode: "2910",
      dueFromOwnerAccountCode: "1350",
    });
    expect(e.lines[0]).toEqual({ accountCode: "1350", debitCents: 21_400 });
  });

  it("zero/negative amounts are typed errors", () => {
    expect(() =>
      buildPersonalReclass({
        entityType: "smllc",
        amountCents: 0,
        occurredOn: "2026-07-01",
        cashAccountCode: "1020",
        drawsAccountCode: "2910",
        dueFromOwnerAccountCode: "1350",
      }),
    ).toThrow(JobCostError);
  });

  it("heuristic FLAGS obvious personal merchants, never posts", () => {
    expect(suspectPersonal("NETFLIX.COM (555) 010-0100").suspect).toBe(true);
    expect(suspectPersonal("Desert Pet Resort").suspect).toBe(true);
    expect(suspectPersonal("SRS DISTRIBUTION #442").suspect).toBe(false);
    expect(suspectPersonal("HOME DEPOT #1234").suspect).toBe(false);
  });

  it("explains the treatment in plain language, by entity type", () => {
    expect(explainPersonal("smllc", 21_400)).toContain("owner draw");
    expect(explainPersonal("s-corp", 21_400)).toContain("lent you");
  });
});
