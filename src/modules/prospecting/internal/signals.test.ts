import { describe, expect, it } from "vitest";
import { customerSignals, rankTargets, type CustomerFacts } from "./signals";

/** Hand-computed oracles, the money-math discipline: every expected weight
 * below was worked out on paper from the rules, not read back from the
 * implementation. */

const base: CustomerFacts = {
  customerId: "c1",
  name: "Ruth Delgado",
  lastJobDaysAgo: 90,
  equipment: [],
  agreementStatus: null,
  agreementEndsInDays: null,
  declinedQuotes: [],
};

describe("customerSignals", () => {
  it("a 12-year water heater is PAST its 11-year life: weight 40 + (12-11)*5 = 45", () => {
    const s = customerSignals({
      ...base,
      equipment: [{ equipmentId: "e1", label: "Garage water heater", kind: "water-heater", ageYears: 12 }],
    });
    expect(s).toHaveLength(1);
    expect(s[0]!.key).toBe("equipment-aging:e1");
    expect(s[0]!.weight).toBe(45);
    expect(s[0]!.reason).toContain("12 years old");
    expect(s[0]!.reason).toContain("about 11");
  });

  it("a 13-year AC is APPROACHING its 14-year life: flat 25, and says 'approaching'", () => {
    const s = customerSignals({
      ...base,
      equipment: [{ equipmentId: "e2", label: "", kind: "ac", ageYears: 13 }],
    });
    expect(s[0]!.weight).toBe(25);
    expect(s[0]!.reason).toContain("approaching");
  });

  it("a 5-year furnace is silent — no signal invented", () => {
    expect(customerSignals({
      ...base,
      equipment: [{ equipmentId: "e3", label: "", kind: "furnace", ageYears: 5 }],
    })).toHaveLength(0);
  });

  it("membership states rank: past_due 45 > lapsed 30 > renewal-window 20", () => {
    expect(customerSignals({ ...base, agreementStatus: "past_due" })[0]!.weight).toBe(45);
    expect(customerSignals({ ...base, agreementStatus: "expired" })[0]!.weight).toBe(30);
    expect(customerSignals({ ...base, agreementStatus: "canceled" })[0]!.weight).toBe(30);
    const renew = customerSignals({ ...base, agreementStatus: "active", agreementEndsInDays: 30 });
    expect(renew[0]!.key).toBe("agreement-renewal");
    expect(renew[0]!.weight).toBe(20);
    // a healthy mid-term membership is NOT a signal
    expect(customerSignals({ ...base, agreementStatus: "active", agreementEndsInDays: 200 })).toHaveLength(0);
  });

  it("a declined $8,450 quote 60 days ago: 15 + floor(845000/500000)=1 -> 16, '2 months'", () => {
    const s = customerSignals({ ...base, declinedQuotes: [{ estimateId: "est-9", daysAgo: 60, totalCents: 845_000 }] });
    expect(s[0]!.weight).toBe(16);
    expect(s[0]!.reason).toContain("$8,450");
    expect(s[0]!.reason).toContain("2 months");
    // keyed by the ESTIMATE, not by daysAgo — a key that drifted daily would
    // shed its dispositions overnight and defeat outreach idempotency
    expect(s[0]!.key).toBe("quote-declined:est-9");
  });

  it("a declined quote past the 180-day lookback is gone — old news is not a signal", () => {
    expect(customerSignals({ ...base, declinedQuotes: [{ estimateId: "est-9", daysAgo: 200, totalCents: 845_000 }] })).toHaveLength(0);
  });

  it("gone-quiet fires ONLY as a last resort: 18+ months silent and nothing else to say", () => {
    const quiet = customerSignals({ ...base, lastJobDaysAgo: 600 });
    expect(quiet).toHaveLength(1);
    expect(quiet[0]!.key).toBe("gone-quiet");
    expect(quiet[0]!.weight).toBe(10);
    // with a real signal present, gone-quiet stays out of the way
    const both = customerSignals({
      ...base,
      lastJobDaysAgo: 600,
      agreementStatus: "expired",
    });
    expect(both.map((s) => s.key)).toEqual(["agreement-lapsed"]);
    // a prospect who never had a job cannot "go quiet"
    expect(customerSignals({ ...base, lastJobDaysAgo: null })).toHaveLength(0);
  });
});

describe("rankTargets", () => {
  it("orders by total weight, ties by name — and never reshuffles", () => {
    const t = rankTargets([
      { ...base, customerId: "a", name: "Zeta Plumbing", agreementStatus: "expired" },           // 30
      { ...base, customerId: "b", name: "Acme HVAC", agreementStatus: "past_due" },              // 45
      { ...base, customerId: "c", name: "Beta Roofing", agreementStatus: "expired" },            // 30 — ties Zeta, wins on name
      { ...base, customerId: "d", name: "Quiet Carl" },                                          // 0 — filtered out
    ]);
    expect(t.map((x) => x.name)).toEqual(["Acme HVAC", "Beta Roofing", "Zeta Plumbing"]);
    expect(t[0]!.score).toBe(45);
  });

  it("a customer stacks signals: 12yr water heater (45) + past_due (45) = 90", () => {
    const t = rankTargets([{
      ...base,
      equipment: [{ equipmentId: "e1", label: "WH", kind: "water-heater", ageYears: 12 }],
      agreementStatus: "past_due",
    }]);
    expect(t[0]!.score).toBe(90);
    expect(t[0]!.signals).toHaveLength(2);
  });
});
