import { describe, expect, it } from "vitest";
import { extendedCents, receiptAverage } from "./avgcost";

describe("receiptAverage", () => {
  it("first receipt sets the average to the receipt cost", () => {
    expect(receiptAverage(0, 0, 100_00, 3200)).toBe(3200);
  });
  it("blends proportionally: 40 @ $32 + 50 @ $36 = $34.22 avg", () => {
    // (4000*3200 + 5000*3600) / 9000 = (12,800,000 + 18,000,000)/9000
    // = 30,800,000/9000 = 3422.22 -> 3422
    expect(receiptAverage(40_00, 3200, 50_00, 3600)).toBe(3422);
  });
  it("half-up on the boundary", () => {
    // (100*10 + 100*11)/200 = 10.5 -> 11
    expect(receiptAverage(1_00, 10, 1_00, 11)).toBe(11);
  });
  it("rejects garbage", () => {
    expect(() => receiptAverage(100, 100, 0, 100)).toThrow();
    expect(() => receiptAverage(-1, 100, 100, 100)).toThrow();
  });
});

describe("extendedCents", () => {
  it("extends x100 quantities", () => {
    expect(extendedCents(60_00, 3200)).toBe(192_000); // 60 @ $32 = $1,920
    expect(extendedCents(2_50, 1000)).toBe(2500); // 2.5 @ $10 = $25
  });
});
