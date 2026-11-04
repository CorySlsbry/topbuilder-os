import { describe, expect, it } from "vitest";
import { pickLeastLoaded } from "./balance";

const A = { workerId: "a", name: "Al" };
const B = { workerId: "b", name: "Bo" };
const C = { workerId: "c", name: "Cy" };

describe("pickLeastLoaded", () => {
  it("picks the least-loaded worker", () => {
    expect(
      pickLeastLoaded([A, B, C], new Map([["a", 3], ["b", 1], ["c", 2]])),
    ).toEqual(B);
  });
  it("unknown load counts as zero", () => {
    expect(pickLeastLoaded([A, B], new Map([["a", 1]]))).toEqual(B);
  });
  it("ties break by name, deterministically", () => {
    expect(pickLeastLoaded([C, A, B], new Map())).toEqual(A);
  });
  it("empty candidates -> null", () => {
    expect(pickLeastLoaded([], new Map())).toBeNull();
  });
});
