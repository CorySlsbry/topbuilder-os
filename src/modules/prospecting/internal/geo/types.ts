import "server-only";

/**
 * Geocoding providers — the FeedProvider discipline applied to coordinates:
 * the book must never learn the provider's name. Adding Google or Nominatim
 * later is a new file, not a migration.
 *
 * Only ever called SERVER-SIDE (cron + API routes), so the browser CSP is
 * untouched — no connect-src widening for any of this.
 */
export interface GeoResult {
  lat: number;
  lng: number;
  /** provider's own confidence/match label, stored nowhere, logged only */
  quality: string;
}

export interface GeoProvider {
  key: "census";
  label: string;
  /** false = the connect path never renders; fails closed like bank feeds */
  isConfigured(): boolean;
  /** null = the provider answered and could NOT resolve it (that is a real
   *  answer — the row moves to 'failed', never retried in a loop) */
  geocode(address: string): Promise<GeoResult | null>;
}

export class GeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeoError";
  }
}
