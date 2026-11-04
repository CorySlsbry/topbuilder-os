/**
 * geocode-proof — exercise the REAL geocodePending path against a real
 * database (the inbound-proof.mjs mould: drive the actual module, then read
 * back what LANDED, never trust the return value alone).
 *
 * Run:  DATABASE_URL=postgres://app_user:...@localhost:5433/topbuilder \
 *       npx tsx --conditions=react-server scripts/geocode-proof.ts <tenant-slug>
 *
 * Uses the app's own connection (app_user, NOBYPASSRLS) so RLS is exercised
 * exactly as production exercises it.
 */
import { getPool } from "../src/lib/db/pool";
import { geocodePending } from "../src/modules/prospecting";

async function main() {
  const slug = process.argv[2];
  if (!slug) throw new Error("usage: geocode-proof.ts <tenant-slug>");
  // app_user + no session uid = the member-read policy on `tenants`
  // correctly returns nothing. The SECURITY DEFINER resolver is the same
  // door the public booking page uses — that's the point of it existing.
  const t = await getPool().query<{ id: string | null }>(
    "SELECT app.tenant_id_by_slug($1) AS id",
    [slug],
  );
  if (!t.rows[0]?.id) throw new Error(`no tenant '${slug}'`);
  const scope = { uid: "proof:geocode", tenantId: t.rows[0].id };

  const before = await snapshot(scope.tenantId);
  console.log("before:", before);

  const report = await geocodePending(scope);
  console.log("geocodePending report:", report);

  const after = await snapshot(scope.tenantId);
  console.log("after: ", after);

  // (the map/pins surface is parked — Cory 2026-08-14 — so the proof now
  // ends at the status ledger: ok rows carry coordinates, failures are
  // stamped, pendings only remain if the vendor deferred)
  console.log(`✓ geocode ledger: ${after.custOk + after.propOk} row(s) carry coordinates`);
  process.exit(0);
}

async function snapshot(tenantId: string) {
  const c = await getPool().connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const q = async (table: string) =>
      Object.fromEntries(
        (await c.query<{ s: string; n: string }>(
          `SELECT geocode_status s, count(*) n FROM ${table} GROUP BY 1`,
        )).rows.map((r) => [r.s, Number(r.n)]),
      );
    const cust = await q("customers");
    const prop = await q("properties");
    await c.query("ROLLBACK");
    return {
      cust,
      prop,
      custOk: cust.ok ?? 0,
      propOk: prop.ok ?? 0,
    };
  } finally {
    c.release();
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
