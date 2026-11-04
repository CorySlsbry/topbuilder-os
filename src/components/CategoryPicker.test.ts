import { describe, expect, it } from "vitest";
import { groupCategories, type CategoryOption } from "./CategoryPicker";

/**
 * What sits at the top of this list is what most bank lines get coded to, so
 * the ordering is behaviour, not decoration.
 */

const cat = (
  code: string,
  name: string,
  type: string,
  section: string | null,
  uses = 0,
): CategoryOption => ({ code, name, type, section, uses });

const CHART: CategoryOption[] = [
  cat("6210", "Fuel and auto", "expense", "Operating expenses", 41),
  cat("6300", "Office supplies", "expense", "Operating expenses", 3),
  cat("4100", "Job materials", "cogs", "Direct costs", 12),
  cat("3100", "Contract revenue", "revenue", "Income", 88),
  cat("1020", "Operating cash", "asset", "Assets", 200),
  cat("2110", "Accounts payable", "liability", "Liabilities", 0),
  cat("9999", "Uncategorized", "other", null, 0),
];

describe("the category picker's ordering", () => {
  it("puts the shop's OWN most-used categories first, and only used ones", () => {
    // The one thing this control is smart about is a COUNT(*), so it is also
    // the one thing it cannot be wrong about. Within a type, most-used wins:
    // 6210 (41 uses) has to beat 6300 (3) or the ranking means nothing.
    const { usual } = groupCategories(CHART, "out");
    expect(usual.map((c) => c.code)).toEqual(["4100", "6210", "6300", "1020", "3100"]);
    expect(usual.every((c) => c.uses > 0)).toBe(true);
  });

  it("ranks cost accounts above income when money went OUT", () => {
    const { usual } = groupCategories(CHART, "out");
    const materials = usual.findIndex((c) => c.code === "4100");
    const revenue = usual.findIndex((c) => c.code === "3100");
    expect(materials).toBeGreaterThanOrEqual(0);
    expect(materials).toBeLessThan(revenue === -1 ? Number.MAX_SAFE_INTEGER : revenue);
  });

  it("ranks income first when money came IN", () => {
    const { usual } = groupCategories(CHART, "in");
    expect(usual[0]!.code).toBe("3100");
  });

  it("⛔ never HIDES an account, whichever direction the money went", () => {
    // A supplier refund is money IN that belongs against the expense it came
    // from, and a bank fee is money OUT that is not revenue. Direction ranks
    // the list; it must never filter it, or the one account somebody actually
    // needs is the one that isn't there.
    for (const dir of ["in", "out"] as const) {
      const { sections } = groupCategories(CHART, dir);
      const codes = sections.flatMap(([, items]) => items.map((i) => i.code)).sort();
      expect(codes).toEqual(CHART.map((c) => c.code).sort());
    }
  });

  it("never shows an account twice inside the section list", () => {
    const { sections } = groupCategories(CHART, "out");
    const codes = sections.flatMap(([, items]) => items.map((i) => i.code));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("gives an account with no section somewhere to live", () => {
    // A null section would otherwise produce an <optgroup label=""> — a blank
    // heading with real accounts under it.
    const { sections } = groupCategories(CHART, "out");
    const orphanGroup = sections.find(([name]) => name === "Other accounts");
    expect(orphanGroup?.[1].map((c) => c.code)).toEqual(["9999"]);
    expect(sections.every(([name]) => name.trim().length > 0)).toBe(true);
  });

  it("caps 'your usual' so the top of the list stays scannable", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      cat(`70${i}`, `Thing ${i}`, "expense", "Operating expenses", i + 1),
    );
    expect(groupCategories(many, "out").usual).toHaveLength(12);
  });

  it("a brand-new shop gets no 'usual' group rather than a wrong one", () => {
    const fresh = CHART.map((c) => ({ ...c, uses: 0 }));
    expect(groupCategories(fresh, "out").usual).toEqual([]);
  });
});
