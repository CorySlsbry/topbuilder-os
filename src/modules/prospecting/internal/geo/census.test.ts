import { describe, expect, it } from "vitest";
import { parseCensus } from "./census";

/** The vendor's response shape is the real contract — pin it. */
describe("parseCensus", () => {
  const good = {
    result: {
      addressMatches: [
        {
          matchedAddress: "1 W NATIONWIDE BLVD, COLUMBUS, OH, 43215",
          coordinates: { x: -83.003, y: 39.968 },
        },
      ],
    },
  };

  it("extracts lat/lng (Census puts LONGITUDE in x)", () => {
    expect(parseCensus(good)).toEqual({ lat: 39.968, lng: -83.003, quality: "matched" });
  });

  it("no match is null, not a throw — 'could not resolve' is a real answer", () => {
    expect(parseCensus({ result: { addressMatches: [] } })).toBeNull();
    expect(parseCensus({})).toBeNull();
    expect(parseCensus(null)).toBeNull();
  });

  it("⛔ rejects coordinates outside the US envelope — a shape change must not become a pin on the equator", () => {
    const swapped = { result: { addressMatches: [{ coordinates: { x: 39.9, y: -83.0 } }] } };
    expect(parseCensus(swapped)).toBeNull();
    const zeros = { result: { addressMatches: [{ coordinates: { x: 0, y: 0 } }] } };
    expect(parseCensus(zeros)).toBeNull();
  });

  it("half a coordinate is null", () => {
    expect(parseCensus({ result: { addressMatches: [{ coordinates: { y: 39.9 } }] } })).toBeNull();
  });
});
