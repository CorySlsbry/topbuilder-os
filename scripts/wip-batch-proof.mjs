/**
 * WIP batch proof — the batched loader returns EXACTLY what the per-job loader
 * returned, on real data, as the real app role.
 *
 * `getWipReport` used to call a 5-query loader once per open job: 40 jobs was
 * 201 sequential round trips. It is now 5 set-based queries. A rewrite like
 * that is invisible to unit tests (the money math is pure and untouched) and
 * invisible to the typechecker (raw SQL is a string), so it needs a control:
 * this script re-implements the ORIGINAL per-job query shape independently and
 * asserts the two agree job for job, field for field.
 *
 * That is the point. If the batch drops a job (a JOIN that should be a LEFT
 * JOIN), double-counts one (a fan-out across two GROUP BYs), or silently
 * returns a string where a number was, the diff shows it here rather than on an
 * owner's WIP screen.
 *
 * Runs as `app_user` — NOBYPASSRLS — with the tenant GUC set, so the queries
 * are exercised under the same RLS policies production runs them under.
 *
 *   node scripts/wip-batch-proof.mjs
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

const dsn = process.env.DATABASE_URL;
if (!dsn) {
  console.error("DATABASE_URL (the app_user role) is required — this must run NOBYPASSRLS.");
  process.exit(1);
}
const db = new Client({ connectionString: dsn });
await db.connect();

// ── pick the tenant with the most open jobs; a 1-job tenant proves nothing ──
//
// ⛔ NOT `SELECT tenant_id, count(*) FROM jobs GROUP BY tenant_id`. On this
// Cloud SQL instance `postgres` is rolbypassrls=false, so FORCE RLS binds even
// the owner: with no app.current_tenant set, that query returns ZERO ROWS and
// this script would cheerfully report "no open jobs" on a database full of
// them. Read the directory table (`tenants` is ENABLE-only) and then count
// per tenant with the GUC set — the same shape app.cron_tenants uses.
const admin = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL ?? dsn });
await admin.connect();
const tenants = await admin.query("SELECT id, slug FROM tenants ORDER BY created_at");
let tenant = null;
let openJobs = 0;
let slug = "";
for (const t of tenants.rows) {
  await admin.query("BEGIN");
  await admin.query("SELECT set_config('app.current_tenant', $1, true)", [t.id]);
  const n = await admin.query(
    "SELECT count(*)::int AS n FROM jobs WHERE status <> 'closed'",
  );
  await admin.query("COMMIT");
  if (n.rows[0].n > openJobs) {
    openJobs = n.rows[0].n;
    tenant = t.id;
    slug = t.slug;
  }
}
await admin.end();
if (!tenant) {
  console.log(
    `No open jobs in any of the ${tenants.rows.length} tenant(s) in this database — nothing to compare. Not a pass.`,
  );
  process.exit(1);
}
console.log(`tenant ${slug} (${tenant}) — ${openJobs} open job(s)\n`);

async function scoped(fn) {
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
  try {
    return await fn();
  } finally {
    await db.query("COMMIT");
  }
}

// ── the ORIGINAL shape, re-implemented here as the control ──────────────────
let perJobQueries = 0;
async function legacyFacts(jobId) {
  const q = async (sql, params) => {
    perJobQueries++;
    return db.query(sql, params);
  };
  const job = await q(
    `SELECT id, name, job_no, contract_cents, budget_cents,
            est_cost_to_complete_cents, etc_updated_at, status
       FROM jobs WHERE id = $1`,
    [jobId],
  );
  const costs = await q(
    `SELECT COALESCE(SUM(amount_cents),0) AS total FROM cost_entries WHERE job_id = $1`,
    [jobId],
  );
  const billed = await q(
    `SELECT COALESCE(SUM(subtotal_cents),0) AS total
       FROM invoices WHERE job_id = $1 AND status <> 'void'`,
    [jobId],
  );
  const committed = await q(
    `SELECT kind, COALESCE(SUM(amount_cents),0) AS total
       FROM purchase_orders WHERE job_id = $1 AND status = 'open' GROUP BY kind`,
    [jobId],
  );
  const byCode = await q(
    `SELECT cost_code AS "costCode", kind, SUM(amount_cents) AS "amountCents"
       FROM cost_entries WHERE job_id = $1
      GROUP BY cost_code, kind ORDER BY SUM(amount_cents) DESC`,
    [jobId],
  );
  return {
    job: job.rows[0],
    costsCents: Number(costs.rows[0].total),
    billedCents: Number(billed.rows[0].total),
    committedPoCents: Number(committed.rows.find((r) => r.kind === "po")?.total ?? 0),
    committedSubCents: Number(committed.rows.find((r) => r.kind === "sub")?.total ?? 0),
    costsByCode: byCode.rows.map((r) => ({
      costCode: r.costCode,
      kind: r.kind,
      amountCents: Number(r.amountCents),
    })),
  };
}

// ── the NEW shape, verbatim from src/modules/job-costing/internal/costing.ts ─
let batchQueries = 0;
async function batchFacts() {
  const q = async (sql, params) => {
    batchQueries++;
    return db.query(sql, params);
  };
  const jobs = await q(
    `SELECT id, name, job_no, contract_cents, budget_cents,
            est_cost_to_complete_cents, etc_updated_at, status
       FROM jobs WHERE status <> 'closed' ORDER BY job_no`,
    [],
  );
  const facts = new Map();
  for (const job of jobs.rows) {
    facts.set(job.id, {
      job,
      costsCents: 0,
      billedCents: 0,
      collectedCents: 0,
      committedPoCents: 0,
      committedSubCents: 0,
      costsByCode: [],
    });
  }
  if (facts.size === 0) return facts;
  const ids = [...facts.keys()];

  const costs = await q(
    `SELECT job_id, COALESCE(SUM(amount_cents),0) AS total
       FROM cost_entries WHERE job_id = ANY($1) GROUP BY job_id`,
    [ids],
  );
  for (const r of costs.rows) facts.get(r.job_id).costsCents = Number(r.total);

  const billed = await q(
    `SELECT job_id, COALESCE(SUM(subtotal_cents),0) AS total
       FROM invoices WHERE job_id = ANY($1) AND status <> 'void' GROUP BY job_id`,
    [ids],
  );
  for (const r of billed.rows) facts.get(r.job_id).billedCents = Number(r.total);

  const collected = await q(
    `SELECT i.job_id, COALESCE(SUM(p.amount_cents),0) AS total
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE i.job_id = ANY($1) AND i.status <> 'void' GROUP BY i.job_id`,
    [ids],
  );
  for (const r of collected.rows) facts.get(r.job_id).collectedCents = Number(r.total);

  const committed = await q(
    `SELECT job_id, kind, COALESCE(SUM(amount_cents),0) AS total
       FROM purchase_orders WHERE job_id = ANY($1) AND status = 'open'
      GROUP BY job_id, kind`,
    [ids],
  );
  for (const r of committed.rows) {
    const f = facts.get(r.job_id);
    if (r.kind === "po") f.committedPoCents = Number(r.total);
    if (r.kind === "sub") f.committedSubCents = Number(r.total);
  }

  const byCode = await q(
    `SELECT job_id, cost_code AS "costCode", kind, SUM(amount_cents) AS "amountCents"
       FROM cost_entries WHERE job_id = ANY($1)
      GROUP BY job_id, cost_code, kind ORDER BY SUM(amount_cents) DESC`,
    [ids],
  );
  for (const r of byCode.rows) {
    facts.get(r.job_id).costsByCode.push({
      costCode: r.costCode,
      kind: r.kind,
      amountCents: Number(r.amountCents),
    });
  }
  return facts;
}

// ── 1. same jobs, same numbers ──────────────────────────────────────────────
console.log("1. the batch agrees with the per-job loader, job for job");
const { batch, legacy } = await scoped(async () => {
  const batch = await batchFacts();
  const legacy = new Map();
  for (const id of batch.keys()) legacy.set(id, await legacyFacts(id));
  return { batch, legacy };
});

check(batch.size === openJobs, `the batch returned all ${openJobs} open jobs (got ${batch.size})`);

const scalars = ["costsCents", "billedCents", "committedPoCents", "committedSubCents"];
let mismatches = 0;
let compared = 0;
for (const [id, b] of batch) {
  const l = legacy.get(id);
  for (const k of scalars) {
    compared++;
    if (b[k] !== l[k]) {
      mismatches++;
      console.log(`     job ${id} ${k}: batch ${b[k]} vs per-job ${l[k]}`);
    }
  }
  // costsByCode is ordered by amount DESC in both; compare as a sorted set so a
  // tie-order difference is not reported as a money difference.
  const key = (r) => `${r.costCode}|${r.kind}|${r.amountCents}`;
  const bc = b.costsByCode.map(key).sort().join(",");
  const lc = l.costsByCode.map(key).sort().join(",");
  compared++;
  if (bc !== lc) {
    mismatches++;
    console.log(`     job ${id} costsByCode differs`);
  }
}
check(mismatches === 0, `${compared} field comparisons across ${batch.size} jobs, ${mismatches} mismatch(es)`);

// ── 2. the numbers are NUMBERS ──────────────────────────────────────────────
// pg returns bigint/numeric as a string. A string that reaches the money math
// turns + into concatenation, and "0" + 12345 is a plausible-looking figure.
console.log("\n2. every figure crossed the boundary as a number, not a pg string");
let stringy = 0;
for (const b of batch.values()) {
  for (const k of [...scalars, "collectedCents"]) {
    if (typeof b[k] !== "number" || !Number.isFinite(b[k])) stringy++;
  }
  for (const r of b.costsByCode) if (typeof r.amountCents !== "number") stringy++;
}
check(stringy === 0, `no string-typed money values (found ${stringy})`);

// ── 3. the round-trip count is the whole point ──────────────────────────────
console.log("\n3. the query count is bounded, not per-job");
console.log(`     batch: ${batchQueries} queries · per-job: ${perJobQueries} queries for ${batch.size} jobs`);
check(batchQueries <= 6, `the batch is a fixed ${batchQueries} queries regardless of job count`);
check(
  batch.size < 2 || batchQueries < perJobQueries,
  `fewer round trips than the loop (${batchQueries} vs ${perJobQueries})`,
);

// ── 4. collected is real money, and it never exceeds what was billed ────────
console.log("\n4. collected money ties to invoices");
const collectedTotal = [...batch.values()].reduce((t, b) => t + b.collectedCents, 0);
const billedTotal = [...batch.values()].reduce((t, b) => t + b.billedCents, 0);
console.log(`     billed $${(billedTotal / 100).toFixed(2)} · collected $${(collectedTotal / 100).toFixed(2)}`);
const ground = await scoped(() =>
  db.query(
    `SELECT COALESCE(SUM(p.amount_cents),0)::bigint AS total
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       JOIN jobs j ON j.id = i.job_id
      WHERE j.status <> 'closed' AND i.status <> 'void'`,
  ),
);
check(
  String(collectedTotal) === String(ground.rows[0].total),
  `Σ per-job collected = the one-shot total (${collectedTotal} vs ${ground.rows[0].total})`,
);

// ── 5. RLS still binds — the batch must not widen the tenant wall ───────────
console.log("\n5. an UNSCOPED batch (no tenant GUC) returns nothing");
await db.query("BEGIN");
const unscoped = await db.query(
  "SELECT count(*)::int AS n FROM jobs WHERE status <> 'closed'",
);
await db.query("COMMIT");
check(unscoped.rows[0].n === 0, `unscoped read sees ZERO jobs (got ${unscoped.rows[0].n})`);

await db.end();

console.log(`\n${"─".repeat(64)}`);
console.log(`${pass} checks passed, ${failures.length} problem(s)`);
if (failures.length) {
  console.log("");
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
console.log("WIP BATCH PROVEN — same numbers, bounded queries\n");
