/**
 * Self-booking proof — N strangers, one remaining slot, exactly one winner.
 *
 * This is the assertion the feature lives or dies on. Availability is computed
 * when slots are DISPLAYED and consumed when one is PICKED, and between those
 * moments anyone else can take it. With staff booking that is a rare annoyance
 * somebody notices; on a public page it is Saturday morning, two strangers,
 * and the shop finds out by driving to one of them.
 *
 * Like scripts/concurrency-proof.mjs, this runs a CONTROL first: it proves the
 * test would actually catch a regression, rather than passing because the race
 * never fired. A concurrency test that has never seen the failure is a test you
 * cannot trust.
 *
 *   pnpm dev                          # AUTH_MODE=dev, against a scratch DB
 *   node scripts/booking-proof.mjs
 */
import { Client } from "pg";

const BASE = process.env.SWEEP_BASE ?? "http://localhost:5150";
const SLUG = `booking-proof-${Date.now()}`;

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

// ── a shop with exactly ONE person, so a half-day holds exactly one job ───
const tenant = (
  await db.query(
    `INSERT INTO tenants (name, slug, timezone) VALUES ('Booking Proof Co', $1, 'America/Phoenix')
     RETURNING id`,
    [SLUG],
  )
).rows[0].id;

async function scoped(sql, params = []) {
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
  try {
    const r = await db.query(sql, params);
    await db.query("COMMIT");
    return r;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}

await scoped(
  `INSERT INTO booking_settings (tenant_id, enabled, days_out, min_lead_hours, updated_by)
   VALUES ($1, true, 14, 0, 'proof')`,
  [tenant],
);
await scoped(
  `INSERT INTO workers (tenant_id, name, trade, base_hourly_cents, wc_class_code)
   VALUES ($1, 'Only Tech', 'hvac', 3000, '5551')`,
  [tenant],
);
console.log(`tenant: ${SLUG}\ncapacity: 1 active worker -> 1 job per half-day\n`);

// ── the offered slots ─────────────────────────────────────────────────────
const avail = await (await fetch(`${BASE}/api/public/book/${SLUG}`)).json();
check(avail.enabled === true, "the public page reports booking ENABLED");
check(avail.days?.length > 0, `slots are offered (${avail.days?.length ?? 0} day(s))`);
const target = avail.days?.[0]?.windows?.[0];
if (!target) {
  console.error("no slot to contend for; cannot continue");
  process.exit(1);
}
console.log(`  contending for ${avail.days[0].date} ${target.label}\n`);

async function book(i) {
  const res = await fetch(`${BASE}/api/public/book/${SLUG}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({
      name: `Racer ${i}`,
      phone: `602555${String(1000 + i)}`,
      // A DISTINCT nonce per racer: this must be a real race, not the
      // idempotency layer quietly collapsing them into one request.
      nonce: `race-${Date.now()}-${i}`,
      startsAt: target.startsAt,
      endsAt: target.endsAt,
    }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── 1. the control: prove the race is REAL without the lock ──────────────
console.log("1. CONTROL — the same race with the lock disabled");
// Neuter the advisory lock, run the race, and confirm it overbooks. If this
// does NOT overbook, the test below proves nothing and must not be trusted.
await db.query(`
  CREATE OR REPLACE FUNCTION app.lock_slot(p_tenant uuid, p_date date, p_window text)
  RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$`);
const controlN = 8;
const control = await Promise.all(Array.from({ length: controlN }, (_, i) => book(i)));
const controlOk = control.filter((r) => r.status === 201).length;
const controlBooked = Number(
  (await scoped(`SELECT count(*) AS n FROM appointments WHERE status = 'scheduled'`)).rows[0].n,
);
console.log(`     ${controlOk}/${controlN} accepted, ${controlBooked} appointment(s) on the book`);
check(
  controlBooked > 1,
  `WITHOUT the lock the slot is overbooked (${controlBooked} appointments in a 1-capacity window)`,
  controlBooked <= 1 ? "the race did not fire — this proof is not proving anything" : "",
);

// reset the shop and restore the real lock
await scoped(`DELETE FROM appointments`);
await scoped(`DELETE FROM intake_requests`);
await scoped(`DELETE FROM jobs`);
await scoped(`DELETE FROM customers`);
await db.query(`
  CREATE OR REPLACE FUNCTION app.lock_slot(p_tenant uuid, p_date date, p_window text)
  RETURNS void LANGUAGE sql AS $$
    SELECT pg_advisory_xact_lock(
      hashtextextended(p_tenant::text || '|' || p_date::text || '|' || p_window, 0))
  $$`);

// ── 2. the real thing ────────────────────────────────────────────────────
console.log("\n2. WITH the lock — N strangers, one slot");
const N = 8;
const results = await Promise.all(Array.from({ length: N }, (_, i) => book(i)));
const accepted = results.filter((r) => r.status === 201).length;
const taken = results.filter((r) => r.body?.error?.code === "slot_taken").length;
console.log(`     ${accepted} accepted, ${taken} told the slot was taken`);
check(accepted === 1, `exactly ONE booking accepted (got ${accepted})`);
check(taken === N - 1, `the other ${N - 1} got a clean slot_taken (got ${taken})`);

const booked = await scoped(
  `SELECT count(*)::int AS n FROM appointments WHERE status = 'scheduled'`,
);
check(booked.rows[0].n === 1, `exactly ONE appointment on the book (got ${booked.rows[0].n})`);

const jobs = await scoped(`SELECT count(*)::int AS n FROM jobs`);
check(jobs.rows[0].n === 1, `and exactly ONE job (got ${jobs.rows[0].n})`);

// ── 3. the same person double-tapping is NOT a race ──────────────────────
console.log("\n3. one customer, one nonce, two taps");
const nonce = `dup-${Date.now()}`;
const second = avail.days[0].windows[1] ?? avail.days[1]?.windows?.[0];
if (second) {
  const body = {
    name: "Double Tapper",
    phone: "6025559999",
    nonce,
    startsAt: second.startsAt,
    endsAt: second.endsAt,
  };
  const [a, b] = await Promise.all([
    fetch(`${BASE}/api/public/book/${SLUG}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify(body),
    }).then((r) => r.status),
    fetch(`${BASE}/api/public/book/${SLUG}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify(body),
    }).then((r) => r.status),
  ]);
  const after = await scoped(
    `SELECT count(*)::int AS n FROM intake_requests WHERE external_id = $1`,
    [nonce],
  );
  check(after.rows[0].n === 1, `one request row for one nonce (got ${after.rows[0].n})`, `${a}/${b}`);
}

// ── 4. the switch is a real gate ─────────────────────────────────────────
console.log("\n4. a shop with booking switched OFF");
await scoped(`UPDATE booking_settings SET enabled = false WHERE tenant_id = $1`, [tenant]);
const offGet = await (await fetch(`${BASE}/api/public/book/${SLUG}`)).json();
check(offGet.enabled === false && offGet.days.length === 0, "the page reports disabled, no slots");
const offPost = await book(99);
check(
  offPost.status === 409 && offPost.body?.error?.code === "booking_disabled",
  `a POST is refused server-side too (got ${offPost.status})`,
);

// ── 5. an unknown shop says nothing about who we host ────────────────────
const unknown = await fetch(`${BASE}/api/public/book/not-a-real-shop`);
check(unknown.status === 404, `an unknown slug is a quiet 404 (got ${unknown.status})`);

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
console.log("SELF-BOOKING PROVEN\n");
