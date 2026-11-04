import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COST_CODE_PRESETS,
  findPreset,
  presetRows,
} from "./cost-code-library";

/**
 * Cost codes are the dimension every job-cost report groups by, so a broken
 * preset is a broken report for every shop that picks it — and it breaks
 * quietly, months later, on a screen nobody is watching while the seed runs.
 */

describe("the cost-code presets", () => {
  it("offers a set for the trades this product sells to", () => {
    expect(COST_CODE_PRESETS.map((p) => p.key).sort()).toEqual([
      "commercial",
      "electrical",
      "hvac",
      "plumbing",
      "roofing",
    ]);
  });

  for (const preset of COST_CODE_PRESETS) {
    describe(preset.key, () => {
      const rows = presetRows(preset);

      it("has no duplicate codes after dedupe", () => {
        // Trade sets deliberately repeat general-conditions codes, so the
        // dedupe is load-bearing: a duplicate would make the seed INSERT
        // conflict with itself mid-statement.
        const codes = rows.map((r) => r.code);
        expect(new Set(codes).size).toBe(codes.length);
      });

      it("gives every code a kind that actually drives the math", () => {
        // labor/material/sub/equipment/other decide burdened labor and the
        // crew-vs-materials split. A wrong one is a wrong NUMBER.
        for (const r of rows) {
          expect(["labor", "material", "sub", "equipment", "other"]).toContain(r.kind);
        }
      });

      it("gives every code a division to group under", () => {
        for (const r of rows) {
          expect(r.division.trim().length, `${r.code} has no division`).toBeGreaterThan(0);
        }
      });

      it("carries the general conditions every job has", () => {
        // Dumpsters, permits and supervision are what make a job look
        // profitable right up until the invoice arrives.
        const codes = rows.map((r) => r.code);
        expect(codes).toContain("01-200"); // permits & inspections
        expect(codes).toContain("01-300"); // dumpster & disposal
        expect(codes).toContain("01-800"); // warranty & callback labor
      });

      it("has at least one labor code and one material-or-sub code", () => {
        // A set that can only book materials cannot cost a job.
        expect(rows.some((r) => r.kind === "labor")).toBe(true);
        expect(rows.some((r) => r.kind === "material" || r.kind === "sub")).toBe(true);
      });

      it("sorts stably, with a gap between entries for later inserts", () => {
        const orders = rows.map((r) => r.sortOrder);
        expect(orders).toEqual([...orders].sort((a, b) => a - b));
        expect(new Set(orders).size).toBe(orders.length);
      });

      it("is worth a shop's time — not two codes in a trench coat", () => {
        expect(rows.length).toBeGreaterThanOrEqual(15);
      });
    });
  }

  it("findPreset answers for real keys and refuses invented ones", () => {
    expect(findPreset("hvac")?.label).toContain("HVAC");
    expect(findPreset("underwater-basket-weaving")).toBeUndefined();
  });
});

/**
 * ⛔ NOBODY HARDCODES A COST CODE AGAIN.
 *
 * `"4100"` was written into four screens and two server paths as the cost
 * code for every job cost in every shop. It is a NAHB homebuilder account
 * that means nothing to an HVAC company, and the effect was that the
 * by-cost-code breakdown on the job money screen had exactly one row in it —
 * a report that looked like a feature and said nothing.
 *
 * Nothing failed. No test broke. It took opening the picker in a browser and
 * reading the options out loud to notice.
 */
describe("no hardcoded cost codes", () => {
  const SRC = join(process.cwd(), "src");

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  const files = walk(SRC)
    .filter((f) => !/\.test\.tsx?$/.test(f))
    // The library IS the list of codes; it is allowed to contain codes.
    .filter((f) => !f.endsWith("cost-code-library.ts"))
    .map((f) => ({
      rel: f.slice(process.cwd().length + 1).replace(/\\/g, "/"),
      src: readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, ""),
    }));

  it("finds the source tree at all (guards a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('⛔ no file ships costCode: "4100" or its equivalents', () => {
    // Matches an assignment of a bare numeric string to anything cost-code
    // shaped, which is the exact shape all six sites had.
    const pattern = /\b(costCode|cost_code|costcode)\b\s*[:=]\s*["'`]\d{3,6}["'`]/i;
    const offenders = files.filter((f) => pattern.test(f.src)).map((f) => f.rel);
    expect(
      offenders,
      "a hardcoded cost code puts every job cost in the business in one bucket — read the shop's own codes (job-costing: listCostCodes / defaultCostCode) instead",
    ).toEqual([]);
  });

  it("the picker refuses to invent a list when the shop has none", () => {
    // The first version fell back to the chart of accounts so the dropdown
    // was never empty, and showed an HVAC shop "land and land development
    // costs" at the top. A wrong vocabulary gets used; an empty one gets
    // fixed.
    const cats = files.find((f) => f.rel.endsWith("bank-rec/internal/categories.ts"))!;
    expect(cats.src).not.toMatch(/type IN \('cogs','expense'\)/);
  });
});
