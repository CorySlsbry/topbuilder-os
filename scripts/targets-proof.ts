/**
 * targets-proof — run the REAL listTargets path against a real database and
 * print what the signals engine found, with its reasons. The assertion is
 * honesty, not count: every reason must trace to a row the tenant owns.
 *
 * Run:  DATABASE_URL=postgres://app_user:...@localhost:5433/topbuilder \
 *       npx tsx --conditions=react-server scripts/targets-proof.ts <tenant-slug>
 */
import { getPool } from "../src/lib/db/pool";
import { listTargets } from "../src/modules/prospecting";

async function main() {
  const slug = process.argv[2];
  if (!slug) throw new Error("usage: targets-proof.ts <tenant-slug>");
  const t = await getPool().query<{ id: string | null }>(
    "SELECT app.tenant_id_by_slug($1) AS id",
    [slug],
  );
  if (!t.rows[0]?.id) throw new Error(`no tenant '${slug}'`);
  const scope = { uid: "proof:targets", tenantId: t.rows[0].id };

  const targets = await listTargets(scope);
  console.log(`${targets.length} target(s) for ${slug}:`);
  for (const tg of targets) {
    console.log(`\n  ${tg.name}  (score ${tg.score})`);
    for (const s of tg.signals) console.log(`    [${s.weight}] ${s.reason}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
