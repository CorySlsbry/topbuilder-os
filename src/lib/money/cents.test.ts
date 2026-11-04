import { describe, it, expect } from "vitest";
import {
  assertCents,
  sumCents,
  formatCents,
  formatMoney,
  parseDollarsToCents,
} from "./cents";

describe("integer-cents primitives", () => {
  it("assertCents rejects non-integers", () => {
    expect(() => assertCents(1.5)).toThrow();
    expect(assertCents(-7)).toBe(-7);
    expect(assertCents(0)).toBe(0);
  });

  it("sumCents adds and stays integral", () => {
    expect(sumCents([100, 250, -50])).toBe(300);
    expect(sumCents([])).toBe(0);
  });

  it("formatMoney groups thousands, for prose", () => {
    expect(formatMoney(600000)).toBe("6,000.00");
    expect(formatMoney(123456789)).toBe("1,234,567.89");
    expect(formatMoney(-1000000)).toBe("-10,000.00");
    // The boundary the naive regex gets wrong.
    expect(formatMoney(99999)).toBe("999.99");
    expect(formatMoney(100000)).toBe("1,000.00");
    expect(formatMoney(7)).toBe("0.07");
    expect(formatMoney(0)).toBe("0.00");
  });

  it("formatCents stays UNGROUPED — parseDollarsToCents round-trips it", () => {
    // Why they are two functions. Commas would break the property test below.
    expect(formatCents(600000)).toBe("6000.00");
  });

  it("formatCents renders dollars.cents", () => {
    expect(formatCents(123456)).toBe("1234.56");
    expect(formatCents(7)).toBe("0.07");
    expect(formatCents(-9)).toBe("-0.09");
    expect(formatCents(0)).toBe("0.00");
  });

  it("parseDollarsToCents rounds half-up", () => {
    expect(parseDollarsToCents("1234.56")).toBe(123456);
    expect(parseDollarsToCents("0.005")).toBe(1); // half-up
    expect(parseDollarsToCents("0.004")).toBe(0);
    expect(parseDollarsToCents("-0.07")).toBe(-7);
    expect(parseDollarsToCents("42")).toBe(4200);
  });

  it("round-trips format(parse(x))", () => {
    for (const s of ["0.00", "1.05", "1234.56", "-0.09"]) {
      expect(formatCents(parseDollarsToCents(s))).toBe(s);
    }
  });
});
