/**
 * Contract-movement proof — the invariants migration 0043 exists to create,
 * checked against a real database as the REAL application role.
 *
 * The endpoint sweep already proves the user-visible half (a second award is
 * refused and the contract survives). This proves the half a route cannot
 * reach: that the cached `jobs.contract_cents` CANNOT drift from the movement
 * history, that the history cannot be rewritten, and that the deliberate
 * legacy exemption still works so nobody "tightens" it into a migration that
 * invents history.
 *
 *   node scripts/contract-proof.mjs        # needs MIGRATE_DATABASE_URL + DATABASE_URL
 */
import { Client } from "pg";

let pass = 0;
const failures = [];
function check(ok, label, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label} ${detail}`);
  }
}

const admin = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await admin.connect();

const SLUG = "contract-proof";

// Start clean, always. A previous run that died mid-way leaves rows behind,
// and the counts below would then read them as this run's — which is exactly
// the shape of a test that reports a failure the code did not cause.
const stale = (await admin.query(`SELECT id FROM tenants WHERE slug = $1`, [SLUG])).rows[0];
if (stale) {
  await admin.query("BEGIN");
  await admin.query("SELECT set_config('app.current_tenant', $1, true)", [stale.id]);
  await admin.query("SELECT app.purge_current_tenant()");
  await admin.query("COMMIT");
  console.log("(purged a leftover proof tenant from a previous run)");
}

const tenant = (
  await admin.query(
    `INSERT INTO tenants (name, slug) VALUES ('Contract Proof Co', $1) RETURNING id`,
    [SLUG],
  )
).rows[0].id;
console.log(`tenant: ${SLUG} (${tenant})\n`);

async function scoped(sql, params = []) {
  await admin.query("BEGIN");
  await admin.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
  try {
    const r = await admin.query(sql, params);
    await admin.query("COMMIT");
    return r;
  } catch (e) {
    await admin.query("ROLLBACK");
    throw e;
  }
}

// A job with a contract and a matching award movement.
const customer = (
  await scoped(`INSERT INTO customers (tenant_id, name) VALUES ($1,'Proof Customer') RETURNING id`, [
    tenant,
  ])
).rows[0].id;
const jobNo = (await scoped(`SELECT app.next_counter('job_no') AS v`)).rows[0].v;
const job = (
  await scoped(
    `INSERT INTO jobs (tenant_id, customer_id, job_no, name, contract_cents)
     VALUES ($1,$2,$3,'Proof job',985000) RETURNING id`,
    [tenant, customer, jobNo],
  )
).rows[0].id;

console.log("1. a job with NO movements can still have its contract set");
// The deliberate legacy exemption: a job created with a contract on day one
// keeps working, and inventing a movement for it would be inventing history.
await scoped(`UPDATE jobs SET contract_cents = 900000 WHERE id = $1`, [job]);
const legacy = await scoped(`SELECT contract_cents FROM jobs WHERE id = $1`, [job]);
check(Number(legacy.rows[0].contract_cents) === 900000, "no history -> a direct set is allowed");

console.log("\n2. once movements exist, the cache must tie out to them");
await scoped(
  `INSERT INTO contract_movements (tenant_id, job_id, seq, kind, delta_cents, created_by)
   VALUES ($1,$2,1,'award',900000,'proof')`,
  [tenant, job],
);
let blocked = false;
try {
  await scoped(`UPDATE jobs SET contract_cents = 123456 WHERE id = $1`, [job]);
} catch (e) {
  blocked = /must equal the sum of contract_movements/.test(e.message);
}
check(blocked, "a contract that disagrees with the movements is REFUSED");

await scoped(
  `INSERT INTO contract_movements (tenant_id, job_id, seq, kind, delta_cents, created_by)
   VALUES ($1,$2,2,'change-order',68000,'proof')`,
  [tenant, job],
);
await scoped(`UPDATE jobs SET contract_cents = 968000 WHERE id = $1`, [job]);
const tied = await scoped(`SELECT contract_cents FROM jobs WHERE id = $1`, [job]);
check(Number(tied.rows[0].contract_cents) === 968000, "a contract that MATCHES the sum is allowed");

console.log("\n3. a DEDUCT is just a negative movement");
await scoped(
  `INSERT INTO contract_movements (tenant_id, job_id, seq, kind, delta_cents, created_by)
   VALUES ($1,$2,3,'change-order',-95000,'proof')`,
  [tenant, job],
);
await scoped(`UPDATE jobs SET contract_cents = 873000 WHERE id = $1`, [job]);
const ded = await scoped(
  `SELECT COALESCE(sum(delta_cents),0)::bigint AS s FROM contract_movements WHERE job_id = $1`,
  [job],
);
check(Number(ded.rows[0].s) === 873000, "sum of movements = 873000 after a deduct");

console.log("\n4. the history is append-only");
let immutable = false;
try {
  await scoped(`UPDATE contract_movements SET delta_cents = 1 WHERE job_id = $1`, [job]);
} catch {
  immutable = true;
}
check(immutable, "a movement cannot be EDITED");
let undeletable = false;
try {
  await scoped(`DELETE FROM contract_movements WHERE job_id = $1`, [job]);
} catch {
  undeletable = true;
}
check(undeletable, "a movement cannot be DELETED");

console.log("\n5. the per-job sequence is unique");
let dupSeq = false;
try {
  await scoped(
    `INSERT INTO contract_movements (tenant_id, job_id, seq, kind, delta_cents, created_by)
     VALUES ($1,$2,3,'change-order',1,'proof')`,
    [tenant, job],
  );
} catch {
  dupSeq = true;
}
check(dupSeq, "two movements cannot share a seq on one job");

console.log("\n6. tenant isolation, as the real app role");
const appDsn = process.env.DATABASE_URL;
if (!appDsn) {
  failures.push("DATABASE_URL not set — cannot run the isolation probe");
} else {
  const app = new Client({ connectionString: appDsn });
  await app.connect();
  const su = await app.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  check(
    !su.rows[0].rolsuper && !su.rows[0].rolbypassrls,
    "the probe runs as a role that CANNOT bypass RLS",
  );
  const other = (
    await admin.query(
      `INSERT INTO tenants (name, slug) VALUES ('Other','contract-proof-other')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    )
  ).rows[0].id;

  await app.query("BEGIN");
  await app.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
  const mine = await app.query(`SELECT count(*)::int AS n FROM contract_movements`);
  await app.query("COMMIT");
  check(mine.rows[0].n === 3, `owning tenant sees its 3 movements (got ${mine.rows[0].n})`);

  await app.query("BEGIN");
  await app.query("SELECT set_config('app.current_tenant', $1, true)", [other]);
  const theirs = await app.query(`SELECT count(*)::int AS n FROM contract_movements`);
  await app.query("COMMIT");
  check(theirs.rows[0].n === 0, `another tenant sees ZERO (got ${theirs.rows[0].n})`);

  await app.query("BEGIN");
  const unscoped = await app.query(`SELECT count(*)::int AS n FROM contract_movements`);
  await app.query("COMMIT");
  check(unscoped.rows[0].n === 0, `an UNSCOPED read returns nothing (got ${unscoped.rows[0].n})`);
  await app.end();
  await admin.query(`DELETE FROM tenants WHERE slug = 'contract-proof-other'`);
}

console.log("\n7. a tenant delete still works — the purge hatch reaches the new table");
// Worth asserting rather than assuming: `contract_movements` is append-only
// with an immutability trigger, and a naive one would BLOCK the cascade and
// quietly break self-service account deletion (a production-readiness gate,
// and a GDPR obligation). It works because app.purge_current_tenant()
// enumerates tables from the CATALOG rather than a hardcoded list, and sets
// app.ledger_purge='on' so the trigger stands aside. A new money table is
// covered the day it is created — but only a test says so.
await admin.query("BEGIN");
await admin.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
const purged = await admin.query("SELECT app.purge_current_tenant() AS n");
await admin.query("COMMIT");
check(Number(purged.rows[0].n) > 0, `purge removed ${purged.rows[0].n} row(s) including the movements`);
const left = await admin.query(
  `SELECT count(*)::int AS n FROM contract_movements WHERE tenant_id = $1`,
  [tenant],
);
check(left.rows[0].n === 0, `no movements survive the purge (got ${left.rows[0].n})`);
const tenantGone = await admin.query(`SELECT count(*)::int AS n FROM tenants WHERE slug = $1`, [SLUG]);
check(tenantGone.rows[0].n === 0, "the tenant row itself is gone");

await admin.end();

console.log(`\n${"─".repeat(64)}`);
console.log(`${pass} checks passed, ${failures.length} problem(s)`);
if (failures.length) {
  console.log("");
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
console.log("CONTRACT MOVEMENTS PROVEN\n");
