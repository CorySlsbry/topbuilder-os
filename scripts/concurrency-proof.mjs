/**
 * Concurrency proof — fires genuinely parallel requests and asserts the
 * outcome, rather than reasoning about what the code ought to do.
 *
 * Four things get proven, each a real failure mode:
 *
 *   1. Idempotency claim contention — N connections race for one key.
 *      Exactly one may win. If two win, both handlers run and the money
 *      moves twice.
 *   2. Bill overpayment race — N concurrent payments of the full balance
 *      against one bill. Exactly one may succeed. This is what the FOR UPDATE
 *      in payBill exists for; without it every caller reads the same
 *      paid_cents, every caller passes the guard, and every caller posts.
 *   3. Per-tenant counters — N concurrent job numbers must be N distinct
 *      values. A duplicate job number is two jobs the shop cannot tell apart.
 *   4. Cross-tenant isolation under load — tenant A hammering the system
 *      must never see or touch tenant B's rows.
 *
 * Run:  node scripts/concurrency-proof.mjs
 * Needs MIGRATE_DATABASE_URL (owner DSN) and DATABASE_URL (app_user DSN).
 */
import { Client, Pool } from "pg";

const OWNER = process.env.MIGRATE_DATABASE_URL;
const APP = process.env.DATABASE_URL ?? OWNER;
if (!OWNER) {
  console.error("Set MIGRATE_DATABASE_URL");
  process.exit(1);
}

const N = 12; // concurrent attempts per scenario
let failures = 0;

function check(name, ok, detail) {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const pool = new Pool({ connectionString: APP, max: N + 4 });

/** Run fn on its own connection with the tenant scope set. */
async function scoped(tenantId, uid, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_uid', $1, true)", [uid]);
    await c.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    await c.query("SELECT set_config('app.current_departments', $1, true)", [
      "field,financials,hr",
    ]);
    const out = await fn(c);
    await c.query("COMMIT");
    return { ok: true, out };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    return { ok: false, err: err.message };
  } finally {
    c.release();
  }
}

const admin = new Client({ connectionString: OWNER });
await admin.connect();

const tenants = (await admin.query("SELECT id, name FROM tenants ORDER BY name")).rows;
if (tenants.length === 0) {
  console.error("No tenants — seed first.");
  process.exit(1);
}
const T = tenants[0];
const OTHER = tenants[1] ?? null;
console.log(`\ntenant under test: ${T.name}\n`);

// ─────────────────────────────────── 1. idempotency claim contention
console.log("1. Idempotency claim — 12 connections race for ONE key");
{
  const key = `proof-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      scoped(T.id, "proof", async (c) => {
        const r = await c.query(
          `INSERT INTO idempotency_keys (tenant_id, key, route, request_hash, claimed_by)
           VALUES ($1,$2,'proof.route','hash','proof')
           ON CONFLICT (tenant_id, key, route) DO NOTHING
           RETURNING key`,
          [T.id, key],
        );
        return r.rowCount === 1;
      }),
    ),
  );
  const winners = results.filter((r) => r.ok && r.out === true).length;
  check("exactly one claim wins", winners === 1, `${winners} of ${N} won`);
  await admin.query("DELETE FROM idempotency_keys WHERE key = $1", [key]);
}

// ─────────────────────────────────── 2. overpayment race (scratch table)
console.log("\n2. Overpayment race — 12 concurrent full-balance payments on ONE balance");
{
  // Deliberately a SCRATCH table, not a real bill.
  //
  // bill_payments carries an immutability trigger (money records are
  // append-only at both layers, by design), so a test that posted real
  // payments could not clean up after itself — it would leave phantom
  // payments and a wrong balance on a live tenant. A proof that damages the
  // thing it is proving is not a proof.
  //
  // The read-modify-write below is byte-for-byte the shape payBill performs:
  // SELECT ... FOR UPDATE, check the remaining balance, then UPDATE. That is
  // the semantics under test; the surrounding table is irrelevant to it.
  await admin.query(`
    CREATE TABLE IF NOT EXISTS _concurrency_proof (
      id int PRIMARY KEY, total_cents bigint NOT NULL, paid_cents bigint NOT NULL DEFAULT 0
    )`);
  await admin.query("TRUNCATE _concurrency_proof");
  await admin.query("INSERT INTO _concurrency_proof VALUES (1, 185000, 0)");
  await admin.query("GRANT SELECT, INSERT, UPDATE ON _concurrency_proof TO app_user");

  const remaining = 185000;
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      scoped(T.id, "proof", async (c) => {
        const { rows } = await c.query(
          "SELECT total_cents, paid_cents FROM _concurrency_proof WHERE id = 1 FOR UPDATE",
        );
        const left = Number(rows[0].total_cents) - Number(rows[0].paid_cents);
        if (remaining > left) throw new Error("amount_exceeds_remaining");
        await c.query(
          "UPDATE _concurrency_proof SET paid_cents = paid_cents + $1 WHERE id = 1",
          [remaining],
        );
        return true;
      }),
    ),
  );
  const paid = results.filter((r) => r.ok).length;
  check("exactly one payment succeeds", paid === 1, `${paid} of ${N} posted`);

  const final = Number(
    (await admin.query("SELECT paid_cents FROM _concurrency_proof WHERE id = 1")).rows[0]
      .paid_cents,
  );
  check("balance is not overpaid", final === remaining, `paid ${final / 100} of ${remaining / 100}`);

  // The same race WITHOUT the lock, to show the guard is doing the work and
  // this test would actually catch its removal.
  await admin.query("UPDATE _concurrency_proof SET paid_cents = 0 WHERE id = 1");
  const unlocked = await Promise.all(
    Array.from({ length: N }, () =>
      scoped(T.id, "proof", async (c) => {
        const { rows } = await c.query(
          "SELECT total_cents, paid_cents FROM _concurrency_proof WHERE id = 1",
        ); // <-- no FOR UPDATE
        const left = Number(rows[0].total_cents) - Number(rows[0].paid_cents);
        if (remaining > left) throw new Error("amount_exceeds_remaining");
        await c.query(
          "UPDATE _concurrency_proof SET paid_cents = paid_cents + $1 WHERE id = 1",
          [remaining],
        );
        return true;
      }),
    ),
  );
  const overpaid = Number(
    (await admin.query("SELECT paid_cents FROM _concurrency_proof WHERE id = 1")).rows[0]
      .paid_cents,
  );
  check(
    "WITHOUT the lock the same code overpays (control)",
    overpaid > remaining,
    `${unlocked.filter((r) => r.ok).length} posted, ${overpaid / 100} vs ${remaining / 100} owed`,
  );

  await admin.query("DROP TABLE _concurrency_proof");
}

// ─────────────────────────────────── 3. counter uniqueness
console.log("\n3. Per-tenant counters — 12 concurrent job numbers must be distinct");
{
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      scoped(T.id, "proof", async (c) => {
        const r = await c.query("SELECT app.next_counter('proof_no') AS v");
        return Number(r.rows[0].v);
      }),
    ),
  );
  const values = results.filter((r) => r.ok).map((r) => r.out);
  const distinct = new Set(values).size;
  check("all values distinct", distinct === values.length, `${distinct} distinct of ${values.length}`);
  check("no gaps or repeats", Math.max(...values) - Math.min(...values) === values.length - 1);
  await admin.query("SELECT set_config('app.current_tenant',$1,false)", [T.id]);
  await admin.query("DELETE FROM tenant_counters WHERE key = 'proof_no' AND tenant_id = $1", [T.id]);
}

// ─────────────────────────────────── 4. isolation under load
console.log("\n4. Cross-tenant isolation while both tenants are active");
if (!OTHER) {
  console.log("  skip — only one tenant exists");
} else {
  const [aSees, bSees] = await Promise.all([
    scoped(T.id, "proof", async (c) =>
      Number((await c.query("SELECT count(*)::int n FROM bills")).rows[0].n),
    ),
    scoped(OTHER.id, "proof", async (c) =>
      Number((await c.query("SELECT count(*)::int n FROM bills")).rows[0].n),
    ),
  ]);
  const aTrue = Number(
    (await admin.query("SELECT count(*)::int n FROM bills WHERE tenant_id=$1", [T.id])).rows[0].n,
  );
  const bTrue = Number(
    (await admin.query("SELECT count(*)::int n FROM bills WHERE tenant_id=$1", [OTHER.id])).rows[0].n,
  );
  check(`${T.name} sees only its own bills`, aSees.out === aTrue, `${aSees.out} vs ${aTrue}`);
  check(`${OTHER.name} sees only its own bills`, bSees.out === bTrue, `${bSees.out} vs ${bTrue}`);

  const leak = await scoped(T.id, "proof", async (c) =>
    Number(
      (await c.query("SELECT count(*)::int n FROM bills WHERE tenant_id = $1", [OTHER.id])).rows[0].n,
    ),
  );
  check("cannot see the other tenant even when naming it", leak.out === 0, `saw ${leak.out}`);
}

await pool.end();
await admin.end();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
