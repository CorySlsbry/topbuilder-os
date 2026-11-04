import "server-only";
import { GeoError, type GeoProvider, type GeoResult } from "./types";

/**
 * US Census Bureau geocoder — provider #1, and the reason there is no
 * NEEDS-CORY entry for this feature: it is keyless, free, and public
 * (geocoding.geo.census.gov). Coverage is US-only, which is exactly the
 * market. Accuracy is street-interpolated, plenty for a territory map;
 * a shop that needs rooftop precision drops the pin by hand ('manual',
 * which the geocoder never overwrites).
 */

const BASE = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

/** Pure: pick coordinates out of a Census response. Exported for tests —
 * the vendor's shape is the contract worth pinning, not our fetch code. */
export function parseCensus(body: unknown): GeoResult | null {
  const matches = (body as { result?: { addressMatches?: unknown[] } })
    ?.result?.addressMatches;
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const m = matches[0] as {
    coordinates?: { x?: number; y?: number };
    tigerLine?: { side?: string };
    matchedAddress?: string;
  };
  const lng = m.coordinates?.x;
  const lat = m.coordinates?.y;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  // A US address cannot be outside these bounds; a value that is says the
  // response shape changed, and a wrong pin is worse than no pin.
  if (lat < 17 || lat > 72 || lng < -180 || lng > -64) return null;
  return { lat, lng, quality: m.matchedAddress ? "matched" : "unlabeled" };
}

export const censusProvider: GeoProvider = {
  key: "census",
  label: "US Census Bureau",
  isConfigured() {
    return true; // keyless by design
  },

  async geocode(address: string): Promise<GeoResult | null> {
    const q = new URLSearchParams({
      address,
      benchmark: "Public_AR_Current",
      format: "json",
    });
    const res = await fetch(`${BASE}?${q}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      // 4xx/5xx from the vendor is OUR problem to retry later, not the
      // address's failure — throw so the row stays 'pending'.
      throw new GeoError(`census returned ${res.status}`);
    }
    return parseCensus(await res.json());
  },
};
