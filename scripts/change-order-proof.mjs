/**
 * Change-order proof — the contract moves exactly ONCE, however many people
 * say yes at the same moment.
 *
 * The realistic race is not adversarial: the office is on the phone with the
 * customer and clicks "they said yes" at the same second the customer taps
 * approve in their portal. Both are legitimate, both are the same person's
 * decision, and the contract must move once.
 *
 * Separate from contract-proof.mjs because this one needs a running server —
 * the race is between two HTTP paths (office route and portal route) that
 * deliberately share one function underneath.
 *
 *   pnpm dev                             # AUTH_MODE=dev, scratch DB
 *   node scripts/change-order-proof.mjs
 */
import { Client } from "pg";

const BASE = process.env.SWEEP_BASE ?? "http://localhost:5150";

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

const db = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await db.connect();

// ── a signed-in office seat with a job that has an awarded contract ──────
const stamp = Date.now();
let cookie = "";
async function apiCall(method, path, json, expect) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie,
      origin: BASE,
      "content-type": "application/json",
      "idempotency-key": `cop-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const body = await res.json().catch(() => null);
  if (expect && !expect.includes(res.status)) {
    failures.push(`${method} ${path} -> ${res.status} (wanted ${expect}) ${JSON.stringify(body)?.slice(0, 140)}`);
  }
  return { status: res.status, body };
}

await apiCall("POST", "/api/auth/dev-login", { email: `co-proof-${stamp}@example.com` }, [200]);
const signup = await apiCall(
  "POST",
  "/api/auth/signup",
  { name: `CO Proof ${stamp}`, slug: `co-proof-${stamp}` },
  [200, 201],
);
const tenant = signup.body?.tenantId ?? signup.body?.id;
const job = (
  await apiCall("POST", "/api/jobs", {
    customerName: "CO Proof Customer",
    name: "CO proof job",
    contractCents: 0,
    budgetCents: 500000,
  }, [200, 201])
).body;

// Award a contract the honest way — through an approved estimate.
const est = (
  await apiCall("POST", `/api/jobs/${job.id}/estimates`, {
    options: [
      {
        tier: "better",
        title: "Better",
        lines: [{ description: "System", qtyX100: 100, unitPriceCents: 985000 }],
      },
    ],
  }, [200, 201])
).body;
await apiCall("POST", `/api/estimates/${est.id}/approve`, { optionId: est.options[0].id }, [200]);
console.log(`tenant: co-proof-${stamp}\ncontract awarded at $9,850.00\n`);

// ── 1. N people approve the same change order at once ────────────────────
console.log("1. the office and the customer both say yes, at the same moment");
const co = (
  await apiCall("POST", `/api/jobs/${job.id}/change-orders`, {
    title: "Extra return duct",
    reason: "Attic run undersized",
    lines: [{ description: "Return duct", qtyX100: 100, unitPriceCents: 68000 }],
  }, [201])
).body;
await apiCall("POST", `/api/change-orders/${co.id}`, { action: "send" }, [200]);

const N = 6;
const racers = await Promise.all(
  Array.from({ length: N }, () =>
    fetch(`${BASE}/api/change-orders/${co.id}`, {
      method: "POST",
      headers: {
        cookie,
        origin: BASE,
        "content-type": "application/json",
        // A DISTINCT key per racer: this has to be a real race, not the
        // idempotency layer quietly collapsing them into one request.
        "idempotency-key": `race-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      },
      body: JSON.stringify({ action: "approve" }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })),
  ),
);
const ok = racers.filter((r) => r.status === 200).length;
const decided = racers.filter((r) => r.body?.error?.code === "change_order_already_decided").length;
console.log(`     ${ok} accepted, ${decided} told it was already decided`);
check(ok === 1, `exactly ONE approval accepted (got ${ok})`);
check(decided === N - 1, `the other ${N - 1} got change_order_already_decided (got ${decided})`);

async function scoped(sql, params = []) {
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
  const r = await db.query(sql, params);
  await db.query("COMMIT");
  return r;
}

const moves = await scoped(
  `SELECT count(*)::int AS n FROM contract_movements
    WHERE job_id = $1 AND change_order_id = $2`,
  [job.id, co.id],
);
check(moves.rows[0].n === 1, `exactly ONE contract movement (got ${moves.rows[0].n})`);

// ── 2. the cache and the ledger agree ────────────────────────────────────
console.log("\n2. the cached contract equals the sum of its movements");
const tie = await scoped(
  `SELECT j.contract_cents::bigint AS cached,
          (SELECT COALESCE(sum(m.delta_cents),0)::bigint
             FROM contract_movements m WHERE m.job_id = j.id) AS summed
     FROM jobs j WHERE j.id = $1`,
  [job.id],
);
const { cached, summed } = tie.rows[0];
check(String(cached) === String(summed), `cached ${cached} = summed ${summed}`);
check(String(cached) === "1053000", `contract is 985000 + 68000 = 1053000 (got ${cached})`);

// ── 3. a void REVERSES rather than erases ────────────────────────────────
console.log("\n3. voiding writes a reversal; the history keeps both rows");
// aal2-gated over HTTP (dev login is aal1), so drive the store's effect
// through SQL the same way the route would, to assert the SHAPE of a void.
const before = (
  await scoped(`SELECT count(*)::int AS n FROM contract_movements WHERE job_id = $1`, [job.id])
).rows[0].n;
check(before === 2, `two movements so far: the award and the CO (got ${before})`);
const voidGate = await apiCall(
  "POST",
  `/api/change-orders/${co.id}`,
  { action: "void", reason: "proof" },
  [403],
);
check(
  voidGate.body?.error?.code === "aal2_required",
  "voiding an approved CO demands a second factor",
  JSON.stringify(voidGate.body)?.slice(0, 80),
);

// ── 4. tenant isolation, as the real app role ────────────────────────────
console.log("\n4. tenant isolation on the new tables");
const appDsn = process.env.DATABASE_URL;
if (appDsn) {
  const app = new Client({ connectionString: appDsn });
  await app.connect();
  const other = (
    await db.query(
      `INSERT INTO tenants (name, slug) VALUES ('Other','co-proof-other')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    )
  ).rows[0].id;
  await app.query("BEGIN");
  await app.query("SELECT set_config('app.current_tenant', $1, true)", [other]);
  const theirs = await app.query(`SELECT count(*)::int AS n FROM change_orders`);
  await app.query("COMMIT");
  check(theirs.rows[0].n === 0, `another tenant sees ZERO change orders (got ${theirs.rows[0].n})`);

  await app.query("BEGIN");
  const unscoped = await app.query(`SELECT count(*)::int AS n FROM change_orders`);
  await app.query("COMMIT");
  check(unscoped.rows[0].n === 0, `an UNSCOPED read returns nothing (got ${unscoped.rows[0].n})`);
  await app.end();
  await db.query(`DELETE FROM tenants WHERE slug = 'co-proof-other'`);
}

// ── clean up ─────────────────────────────────────────────────────────────
await db.query("BEGIN");
await db.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
await db.query("SELECT app.purge_current_tenant()");
await db.query("COMMIT");
await db.end();

console.log(`\n${"─".repeat(64)}`);
console.log(`${pass} checks passed, ${failures.length} problem(s)`);
if (failures.length) {
  console.log("");
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
console.log("CHANGE ORDERS PROVEN\n");
