import { describe, expect, it } from "vitest";
import {
  extractNumericTokens,
  figureUniverse,
  normalizeNumber,
  verifyFigures,
} from "./figures";
import { distillPreference } from "./learning-pure";

describe("extractNumericTokens", () => {
  it("finds money, plain numbers, and percents", () => {
    expect(extractNumericTokens("Pay $1,234.56 (about 12% of 9,000)")).toEqual([
      "$1,234.56",
      "12%",
      "9,000",
    ]);
  });
  it("ignores dates and identifiers", () => {
    expect(
      extractNumericTokens("On 2026-07-24 (07/24/2026) invoice INV-1001 for job #1 was sent"),
    ).toEqual([]);
  });
});

describe("normalizeNumber", () => {
  it("canonicalizes formats", () => {
    expect(normalizeNumber("$1,234.50")).toBe("1234.5");
    expect(normalizeNumber("9,000")).toBe("9000");
    expect(normalizeNumber("12%")).toBe("12");
  });
});

describe("verifyFigures — the firewall", () => {
  it("passes a faithful draft", () => {
    const r = verifyFigures(
      "This $842.00 charge looks like materials — about 8% of the job.",
      figureUniverse([84200, "8"]),
    );
    expect(r.ok).toBe(true);
  });
  it("catches an invented figure", () => {
    const r = verifyFigures(
      "This $850.00 charge looks like materials.",
      figureUniverse([84200]),
    );
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(["850"]);
  });
  it("catches a subtly-wrong cent amount", () => {
    const r = verifyFigures("You are owed $9,000.01.", figureUniverse([900000]));
    expect(r.ok).toBe(false);
  });
  it("cents figures allow the dollar rendering", () => {
    expect(verifyFigures("Collected $9,000.00 today.", figureUniverse([900000])).ok).toBe(true);
    expect(verifyFigures("Collected 900000 cents.", figureUniverse([900000])).ok).toBe(true);
  });
  it("an all-text draft always passes", () => {
    expect(verifyFigures("Looks like a personal charge to me.", []).ok).toBe(true);
  });
});

describe("distillPreference (CIPHER)", () => {
  it("distills field diffs into a readable rule", () => {
    const rule = distillPreference(
      { costCode: "4100", jobId: "a" },
      { costCode: "4200" },
    );
    expect(rule).toBe('When proposing similar actions: prefer costCode="4200" over "4100".');
  });
  it("no-op edit distills nothing", () => {
    expect(distillPreference({ a: 1 }, { a: 1 })).toBeNull();
  });
});
