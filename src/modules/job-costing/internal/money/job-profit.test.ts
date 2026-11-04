import { describe, expect, it } from "vitest";
import {
  computeJobProfit,
  crewProfitView,
  explainJobProfit,
  type JobProfitInput,
} from "./job-profit";
import { computeWip } from "./wip";

const money = (c: number) =>
  (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const base: JobProfitInput = {
  contractCents: 985_000,
  billedCents: 600_000,
  collectedCents: 400_000,
  postedCostsCents: 380_000,
  unpostedLaborCents: 0,
};

describe("computeJobProfit", () => {
  it("billed profit is billed minus everything spent", () => {
    const r = computeJobProfit(base);
    expect(r.totalCostsCents).toBe(380_000);
    expect(r.billedProfitCents).toBe(220_000);
  });

  it("collected profit is a DIFFERENT number, and lower until they pay", () => {
    const r = computeJobProfit(base);
    expect(r.collectedProfitCents).toBe(20_000);
    expect(r.collectedProfitCents).toBeLessThan(r.billedProfitCents);
  });

  it("margin is measured against what was BILLED, not the contract", () => {
    // 220,000 / 600,000 = 36.67% -> 3667 bps. Against the contract it would
    // read 2234 and a half-billed healthy job would look thin.
    expect(computeJobProfit(base).billedMarginBps).toBe(3667);
  });

  it("unposted labor lands in cost and moves the margin", () => {
    const r = computeJobProfit({ ...base, unpostedLaborCents: 84_000 });
    expect(r.totalCostsCents).toBe(464_000);
    expect(r.billedProfitCents).toBe(136_000);
    expect(r.flags.unpostedLaborPresent).toBe(true);
    // The whole reason the flag exists: without it this job reads $220,000
    // profitable all week and settles $84,000 lower every Friday.
    expect(r.billedProfitCents).toBeLessThan(computeJobProfit(base).billedProfitCents);
  });

  it("nothing billed yet is not an infinite loss", () => {
    const r = computeJobProfit({ ...base, billedCents: 0, collectedCents: 0 });
    expect(r.billedMarginBps).toBe(0);
    expect(r.collectedMarginBps).toBe(0);
    expect(r.flags.noBillingYet).toBe(true);
  });

  it("a loss reads negative, in both the profit and the margin", () => {
    const r = computeJobProfit({ ...base, postedCostsCents: 700_000 });
    expect(r.billedProfitCents).toBe(-100_000);
    expect(r.billedMarginBps).toBe(-1667);
    expect(r.flags.underwater).toBe(true);
  });

  it("unbilled contract never goes negative — over-billing is a flag, not a backlog", () => {
    expect(computeJobProfit({ ...base, billedCents: 1_200_000 }).unbilledContractCents).toBe(0);
  });
});

describe("billed profit and WIP gross profit are DIFFERENT numbers", () => {
  it("a fat estimate-to-complete moves WIP and leaves billed profit alone", () => {
    // This is the whole reason both exist. The owner's ETC drives WIP; it has
    // no bearing on what has actually been billed and spent.
    const wipOptimistic = computeWip({
      contractCents: 985_000,
      costsToDateCents: 380_000,
      estCostToCompleteCents: 100_000, // "nearly done"
      billedToDateCents: 600_000,
      etcAgeDays: 1,
    });
    const wipPessimistic = computeWip({
      contractCents: 985_000,
      costsToDateCents: 380_000,
      estCostToCompleteCents: 400_000, // "lots left"
      billedToDateCents: 600_000,
      etcAgeDays: 1,
    });

    expect(wipOptimistic.grossProfitCents).not.toBe(wipPessimistic.grossProfitCents);

    // Billed profit is identical in both worlds, because nothing that actually
    // happened changed. That is why the crew sees THIS number: it cannot swing
    // because somebody re-estimated the job.
    const profit = computeJobProfit(base);
    expect(profit.billedProfitCents).toBe(220_000);
  });
});

describe("explainJobProfit", () => {
  it("reads in plain English with the figures verbatim", () => {
    const text = explainJobProfit(computeJobProfit(base), money);
    expect(text).toContain("$6,000.00");
    expect(text).toContain("$3,800.00");
    expect(text).toContain("made you $2,200.00");
    // 3667 bps is 36.67%, and the sentence rounds it to whole cents.
    expect(text).toContain("37 cents of every dollar");
    expect(text).toContain("$3,850.00"); // still to invoice
  });

  it("says LOST rather than showing a minus sign", () => {
    const text = explainJobProfit(computeJobProfit({ ...base, postedCostsCents: 700_000 }), money);
    expect(text).toContain("LOST you $1,000.00");
    expect(text).toContain("underwater");
    // The words carry the direction; a minus sign in prose makes an owner
    // stop and decode it.
    expect(text).not.toContain("-$");
  });

  it("warns when part of the cost is hours nobody has posted", () => {
    const text = explainJobProfit(computeJobProfit({ ...base, unpostedLaborCents: 84_000 }), money);
    expect(text).toContain("nobody has posted");
  });

  it("a job with no billing gets a sentence about spending, not a fake margin", () => {
    const text = explainJobProfit(
      computeJobProfit({ ...base, billedCents: 0, collectedCents: 0 }),
      money,
    );
    expect(text).toContain("haven't invoiced anything yet");
    expect(text).not.toContain("cents of every dollar");
  });
});

describe("crewProfitView — a redaction, tested for ABSENCE", () => {
  const full = computeJobProfit({ ...base, unpostedLaborCents: 84_000 });
  const view = crewProfitView(full, money);

  // The whole point of the function. If someone adds a field to
  // JobProfitResult and it appears here, this fails — which is the decision
  // this test exists to force somebody to make on purpose.
  const FORBIDDEN = [
    "collectedCents",
    "collectedProfitCents",
    "collectedMarginBps",
    "unbilledContractCents",
    "flags",
    "costsByCode",
    "etcCents",
    "wip",
  ];

  it("carries exactly four figures and one sentence — nothing else", () => {
    expect(Object.keys(view).sort()).toEqual(
      ["billedCents", "billedMarginBps", "billedProfitCents", "explain", "totalCostsCents"],
    );
  });

  for (const key of FORBIDDEN) {
    it(`does not expose ${key}`, () => {
      expect(view).not.toHaveProperty(key);
      // Also not smuggled through the prose. A redacted object with a
      // chatty sentence is not redacted.
      expect(JSON.stringify(view)).not.toContain(key);
    });
  }

  it("never names the unbilled contract, in a key OR in the sentence", () => {
    // $3,850.00 is base's unbilled contract. The owner's explainer says it out
    // loud; the crew's must not, or the redaction leaks through the prose.
    expect(view.explain).not.toContain("3,850");
    expect(view.explain).not.toContain("contract");
    expect(explainJobProfit(full, money)).toContain("$3,850.00"); // control
  });

  it("keeps the unposted-hours caveat — the number is not final yet", () => {
    // Dropping this would make the figure look settled on Wednesday and land
    // lower on Friday, which reads as the shop moving the goalposts.
    expect(view.explain).toContain("haven't been posted");
  });

  it("shows the SAME billed figures the owner sees — narrower, not different", () => {
    expect(view.billedProfitCents).toBe(full.billedProfitCents);
    expect(view.billedMarginBps).toBe(full.billedMarginBps);
    expect(view.totalCostsCents).toBe(full.totalCostsCents);
  });

  it("a loss is not hidden from the crew", () => {
    const lossView = crewProfitView(computeJobProfit({ ...base, postedCostsCents: 700_000 }), money);
    expect(lossView.billedProfitCents).toBe(-100_000);
    expect(lossView.explain).toContain("LOST");
  });
});

describe("the collected-profit trap", () => {
  it("flags 'nothing collected yet' rather than reporting a loss", () => {
    // The invoice is out, the customer hasn't paid. Collected profit is
    // arithmetically -$3,800 and the impression — a healthy job showing a big
    // red loss — is flatly wrong. The flag is what lets the screen say
    // "nothing collected yet" instead.
    const r = computeJobProfit({ ...base, collectedCents: 0 });
    expect(r.collectedProfitCents).toBe(-380_000);
    expect(r.flags.noCollectionYet).toBe(true);
    expect(r.flags.underwater).toBe(false); // the job itself is fine
  });

  it("clears once a single dollar lands", () => {
    expect(computeJobProfit({ ...base, collectedCents: 100 }).flags.noCollectionYet).toBe(false);
  });
});
