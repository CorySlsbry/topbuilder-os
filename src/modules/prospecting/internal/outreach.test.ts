import { describe, expect, it } from "vitest";
import { figureUniverse, verifyFigures } from "@/modules/agents";
import { outreachDraft } from "./outreach";
import type { Signal, Target } from "./signals";

/** Hand-built targets, hand-checked words. The standing invariant at the
 * bottom is the one that matters: every message must pass the same figure
 * firewall the gate would apply to a drafted summary, using only the
 * figures the draft itself declares. */

const t = (name: string, signals: Signal[]): Target => ({
  customerId: "c1",
  name,
  score: signals.reduce((s, x) => s + x.weight, 0),
  signals,
});

const BIZ = "Desert Aire Mechanical";

describe("outreachDraft", () => {
  it("a unit past its life gets the planned-replacement pitch, with its real age", () => {
    const d = outreachDraft(
      t("Ruth Delgado", [
        { key: "equipment-aging:e1", reason: "r", weight: 45, facts: { unit: "water heater", ageYears: 12, life: 11, past: 1 } },
      ]),
      BIZ,
    )!;
    expect(d.signalKey).toBe("equipment-aging:e1");
    expect(d.message).toContain("water heater is 12 years old now");
    expect(d.message).toContain("past the 11");
    expect(d.figures).toEqual([12, 11]);
  });

  it("a unit approaching its life gets the no-rush version", () => {
    const d = outreachDraft(
      t("Gary Pearce", [
        { key: "equipment-aging:e2", reason: "r", weight: 25, facts: { unit: "AC", ageYears: 13, life: 14, past: 0 } },
      ]),
      BIZ,
    )!;
    expect(d.message).toContain("No rush today");
    expect(d.message).toContain("13 years old");
  });

  it("a declined $8,450 quote two months back is re-opened politely, dollars intact", () => {
    const d = outreachDraft(
      t("Hal & Doreen Brandt", [
        { key: "quote-declined:est9", reason: "r", weight: 16, facts: { totalCents: 845_000, months: 2 } },
      ]),
      BIZ,
    )!;
    expect(d.message).toContain("$8,450");
    expect(d.message).toContain("2 months ago");
    expect(d.figures).toEqual([2, 845_000]);
  });

  it("a non-whole-dollar quote keeps its exact cents — $8,450.50, never $8,451", () => {
    const d = outreachDraft(
      t("Precise Pat", [
        { key: "quote-declined:est7", reason: "r", weight: 16, facts: { totalCents: 845_050, months: 2 } },
      ]),
      BIZ,
    )!;
    expect(d.message).toContain("$8,450.50");
    expect(d.message).not.toContain("$8,451");
    const check = verifyFigures(d.message, figureUniverse(d.figures));
    expect(check.violations).toEqual([]);
  });

  it("renewal in 1 day reads singular", () => {
    const d = outreachDraft(
      t("Amy Chow", [
        { key: "agreement-renewal", reason: "r", weight: 20, facts: { endsInDays: 1 } },
      ]),
      BIZ,
    )!;
    expect(d.message).toContain("in 1 day.");
  });

  it("ties in weight break by key, so the pick never flips between runs", () => {
    const d = outreachDraft(
      t("Sunridge Apartments", [
        { key: "equipment-aging:e9", reason: "rtu", weight: 45, facts: { unit: "rooftop unit", ageYears: 18, life: 17, past: 1 } },
        { key: "agreement-past-due", reason: "pd", weight: 45, facts: {} },
      ]),
      BIZ,
    )!;
    // "agreement-past-due" < "equipment-aging:e9"
    expect(d.signalKey).toBe("agreement-past-due");
    expect(d.message).toContain("payment did not go through");
    expect(d.figures).toEqual([]);
  });

  it("an unknown signal kind stays generic instead of guessing", () => {
    const d = outreachDraft(
      t("X", [{ key: "some-future-signal", reason: "r", weight: 50, facts: { mystery: 7 } }]),
      BIZ,
    )!;
    expect(d.message).toContain("check in");
    expect(d.figures).toEqual([]);
  });

  it("no signals -> no draft", () => {
    expect(outreachDraft(t("Empty", []), BIZ)).toBeNull();
  });

  it("a digit-bearing business name joins the allowed figures", () => {
    const d = outreachDraft(
      t("Ruth Delgado", [
        { key: "gone-quiet", reason: "r", weight: 10, facts: { months: 20 } },
      ]),
      "Route 66 Roofing",
    )!;
    expect(d.figures).toContain("66");
  });

  it("INVARIANT: every message passes the figure firewall on its own declared figures", () => {
    const cases: [Target, string][] = [
      [t("A", [{ key: "equipment-aging:e1", reason: "r", weight: 45, facts: { unit: "furnace", ageYears: 19, life: 18, past: 1 } }]), BIZ],
      [t("B", [{ key: "equipment-aging:e2", reason: "r", weight: 25, facts: { unit: "heat pump", ageYears: 12, life: 14, past: 0 } }]), BIZ],
      [t("C", [{ key: "agreement-past-due", reason: "r", weight: 45, facts: {} }]), BIZ],
      [t("D", [{ key: "agreement-lapsed", reason: "r", weight: 30, facts: {} }]), BIZ],
      [t("E", [{ key: "agreement-renewal", reason: "r", weight: 20, facts: { endsInDays: 21 } }]), BIZ],
      [t("F", [{ key: "quote-declined:e", reason: "r", weight: 17, facts: { totalCents: 1_240_000, months: 3 } }]), BIZ],
      [t("G", [{ key: "gone-quiet", reason: "r", weight: 10, facts: { months: 20 } }]), BIZ],
      [t("H", [{ key: "quote-declined:e", reason: "r", weight: 16, facts: { totalCents: 845_000, months: 2 } }]), "Acme Home Services"],
    ];
    for (const [target, biz] of cases) {
      const d = outreachDraft(target, biz)!;
      const check = verifyFigures(d.message, figureUniverse(d.figures));
      expect(check.violations, `${target.name}: "${d.message}"`).toEqual([]);
      expect(check.ok).toBe(true);
    }
  });
});
