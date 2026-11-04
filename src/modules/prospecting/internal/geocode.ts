import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { censusProvider } from "./geo/census";
import { GeoError } from "./geo/types";

/**
 * Turn the book's addresses into coordinates — idempotently, politely.
 *
 * Runs nightly from the cron (and can be invoked from a route). The status
 * column is the whole state machine: only 'pending' rows are ever attempted;
 * 'manual' pins are structurally untouchable because the UPDATE predicate
 * requires status='pending'; a vendor outage leaves rows 'pending' for the
 * next night, while a real "no such address" moves them to 'failed' exactly
 * once. Re-running adds zero work on a settled book.
 */

const PER_RUN = 40;      // per tenant per night — a book geocodes in days, quietly
const GAP_MS = 200;      // stay a polite guest on a free government API

interface PendingRow {
  kind: "customer" | "property";
  id: string;
  address: string;
}

export interface GeocodeReport {
  attempted: number;
  ok: number;
  failed: number;
  deferred: number; // vendor errored; rows stay pending for the next run
}

export async function geocodePending(scope: TenantScope): Promise<GeocodeReport> {
  const pending = await withTenant(scope, async (c) => {
    const { rows } = await c.query<PendingRow>(
      `SELECT 'customer' AS kind, id, address FROM customers
        WHERE geocode_status = 'pending'
        UNION ALL
       SELECT 'property' AS kind, id, address FROM properties
        WHERE geocode_status = 'pending'
        LIMIT $1`,
      [PER_RUN],
    );
    return rows;
  });

  const report: GeocodeReport = { attempted: 0, ok: 0, failed: 0, deferred: 0 };
  for (const row of pending) {
    report.attempted++;
    let result;
    try {
      result = await censusProvider.geocode(row.address);
    } catch (err) {
      // Vendor trouble is not the address's fault: leave 'pending', try
      // tomorrow, and say so in the cron report rather than burning the row.
      if (err instanceof GeoError) {
        report.deferred++;
        continue;
      }
      throw err;
    }
    const table = row.kind === "customer" ? "customers" : "properties";
    await withTenant(scope, (c) =>
      result
        ? c.query(
            // status='pending' in the predicate is the manual-pin guarantee
            `UPDATE ${table} SET lat = $2, lng = $3, geocode_status = 'ok',
                    geocoded_at = now()
              WHERE id = $1 AND geocode_status = 'pending'`,
            [row.id, result.lat, result.lng],
          )
        : c.query(
            `UPDATE ${table} SET geocode_status = 'failed', geocoded_at = now()
              WHERE id = $1 AND geocode_status = 'pending'`,
            [row.id],
          ),
    );
    if (result) report.ok++;
    else report.failed++;
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  return report;
}
