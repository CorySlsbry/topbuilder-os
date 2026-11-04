/**
 * Job-profit visibility proof — the redaction holds over HTTP, for a real
 * second seat, on a real job with real money.
 *
 * `crewProfitView` is unit-tested for the absence of forbidden keys, and that
 * test is worth having. It is also not the thing that protects a shop: the
 * object could be perfect and the ROUTE could still hand the full result to
 * the wrong person, or refuse the right one, or forget that owner/admin
 * implicitly hold every department wall and serve the owner a redacted view of
 * their own job.
 *
 * So this drives two actual sessions:
 *   - an OWNER, who must see everything
 *   - a CREW seat (role `staff`, no financials grant), who must see nothing
 *     until the shop switches disclosure on, and then must see exactly four
 *     figures and one sentence
 *
 * The crew membership is created in SQL rather than through /api/team, because
 * adding a member requires a second factor that a dev login cannot produce.
 * That is the team route's gate doing its job; it is not what this script is
 * testing.
 *
 *   pnpm dev                                  # AUTH_MODE=dev
 *   node scripts/profit-visibility-proof.mjs
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

const stamp = Date.now();

/** Two independent cookie jars — one per person. */
function jar() {
  let cookie = "";
  return async function callAs(method, path, json, expect) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        cookie,
        origin: BASE,
        "content-type": "application/json",
        "idempotency-key": `pv-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const body = await res.json().catch(() => null);
    if (expect && !expect.includes(res.status)) {
      failures.push(
        `${method} ${path} -> ${res.status} (wanted ${expect}) ${JSON.stringify(body)?.slice(0, 160)}`,
      );
    }
    return { status: res.status, body };
  };
}

const owner = jar();
const crew = jar();

// ── set up a shop with one job that has actually made money ──────────────
await owner("POST", "/api/auth/dev-login", { email: `pv-owner-${stamp}@example.com` }, [200]);
const signup = await owner(
  "POST",
  "/api/auth/signup",
  { name: `PV Proof ${stamp}`, slug: `pv-proof-${stamp}` },
  [200, 201],
);
const tenant = signup.body?.tenantId ?? signup.body?.id;

const job = (
  await owner("POST", "/api/jobs", {
    customerName: "PV Customer",
    name: "PV proof job",
    contractCents: 0,
    budgetCents: 500000,
  }, [200, 201])
).body;

const est = (
  await owner("POST", `/api/jobs/${job.id}/estimates`, {
    options: [
      {
        tier: "better",
        title: "Better",
        lines: [{ description: "System", qtyX100: 100, unitPriceCents: 985000 }],
      },
    ],
  }, [200, 201])
).body;
await owner("POST", `/api/estimates/${est.id}/approve`, { optionId: est.options[0].id }, [200]);
const today = new Date().toISOString().slice(0, 10);
await owner("POST", `/api/jobs/${job.id}/costs`, {
  costCode: "3810",
  kind: "material",
  amountCents: 380000,
  occurredOn: today,
  memo: "Equipment",
}, [200, 201]);
await owner("POST", `/api/jobs/${job.id}/invoices`, {
  subtotalCents: 600000,
  issuedOn: today,
  memo: "Progress billing",
}, [200, 201]);
console.log(`tenant pv-proof-${stamp}: contract $9,850 · billed $6,000 · cost $3,800\n`);

// ── 1. the owner sees everything ──────────────────────────────────────────
console.log("1. the owner sees the whole picture");
const full = await owner("GET", `/api/jobs/${job.id}/profit`, undefined, [200]);
if (process.env.PV_DEBUG) console.log(JSON.stringify(full.body, null, 2));
check(full.body?.view === "full", `view is "full" (got ${full.body?.view})`);
check(
  full.body?.profit?.billedProfitCents === 220000,
  `billed profit is $2,200.00 (got ${full.body?.profit?.billedProfitCents})`,
);
check(
  typeof full.body?.profit?.collectedProfitCents === "number",
  "the owner gets collected profit",
);
check(
  typeof full.body?.wip?.grossProfitCents === "number",
  "the owner gets the WIP gross profit, labelled as the other number",
);
check(typeof full.body?.explain === "string" && full.body.explain.length > 0, "and a sentence");

// ── 2. a crew seat, with no financials grant ──────────────────────────────
console.log("\n2. a crew seat joins with role staff and NO department grants");
const crewUid = `dev:pv-crew-${stamp}@example.com`;
await db.query("BEGIN");
await db.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
await db.query(
  `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'staff')
   ON CONFLICT DO NOTHING`,
  [tenant, crewUid],
);
await db.query("COMMIT");

await crew("POST", "/api/auth/dev-login", { email: `pv-crew-${stamp}@example.com` }, [200]);
await crew("POST", "/api/auth/select-tenant", { tenantId: tenant }, [200]);

// The wall this seat genuinely does not hold — a control for everything below.
const walled = await crew("GET", `/api/jobs/${job.id}/costing`, undefined, [403]);
check(
  walled.body?.error?.code === "department_forbidden",
  "the crew seat is refused /costing, as it always was",
  JSON.stringify(walled.body)?.slice(0, 80),
);

// ── 3. disclosure OFF is the default, and it refuses ──────────────────────
console.log("\n3. with the shop's setting OFF (the default), profit is refused");
const off = await crew("GET", `/api/jobs/${job.id}/profit`, undefined, [403]);
check(
  off.body?.error?.code === "department_forbidden",
  "refused with the SAME code as any other financials refusal",
  JSON.stringify(off.body)?.slice(0, 80),
);
// A distinct code here would tell someone without access that the setting
// exists and that their boss has it switched off — a small fact about the
// shop, leaked by an error message.
check(
  JSON.stringify(off.body ?? {}).toLowerCase().includes("visib") === false,
  "the refusal does not mention the setting at all",
);

// ── 4. the switch itself demands a second factor ──────────────────────────
console.log("\n4. switching disclosure on demands a second factor");
const gate = await owner(
  "PATCH",
  "/api/settings/job-visibility",
  { crewSeesProfit: true },
  [403],
);
check(
  gate.body?.error?.code === "aal2_required",
  "an aal1 owner cannot flip it",
  JSON.stringify(gate.body)?.slice(0, 80),
);
const crewFlip = await crew(
  "PATCH",
  "/api/settings/job-visibility",
  { crewSeesProfit: true },
  [403],
);
check(
  crewFlip.body?.error?.code === "role_forbidden" ||
    crewFlip.body?.error?.code === "aal2_required",
  `and a crew seat certainly cannot (got ${crewFlip.body?.error?.code})`,
);

// Flip it the way a 2FA'd owner would, so the read path can be tested.
await db.query("BEGIN");
await db.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
const flipped = await db.query(
  `INSERT INTO job_visibility_settings (tenant_id, crew_sees_profit) VALUES ($1,true)
   ON CONFLICT (tenant_id) DO UPDATE SET crew_sees_profit = true
   RETURNING crew_sees_profit`,
  [tenant],
);
await db.query("COMMIT");
check(flipped.rows[0]?.crew_sees_profit === true, "setting switched on for the read test");

// ── 5. ON: exactly four figures and one sentence ──────────────────────────
console.log("\n5. with it ON, the crew gets the narrowed view and nothing more");
const view = await crew("GET", `/api/jobs/${job.id}/profit`, undefined, [200]);
check(view.body?.view === "crew", `view is "crew" (got ${view.body?.view})`);
check(
  view.body?.profit?.billedProfitCents === 220000,
  `the same $2,200.00 the owner sees — narrower, not different (got ${view.body?.profit?.billedProfitCents})`,
);
check(
  JSON.stringify(Object.keys(view.body?.profit ?? {}).sort()) ===
    JSON.stringify(["billedCents", "billedMarginBps", "billedProfitCents", "totalCostsCents"]),
  `exactly four figures (got ${Object.keys(view.body?.profit ?? {}).sort().join(",")})`,
);

// The real test: nothing forbidden anywhere in the response, including inside
// the prose. A redacted object with a chatty sentence is not redacted.
const raw = JSON.stringify(view.body ?? {});
const FORBIDDEN = [
  "collectedProfitCents",
  "collectedCents",
  "collectedMarginBps",
  "unbilledContractCents",
  "costsByCode",
  "etcCents",
  "grossProfitCents",
  "underbilledCents",
  "overbilledCents",
  "unpostedLabor",
];
const leaked = FORBIDDEN.filter((k) => raw.includes(k));
check(leaked.length === 0, `no forbidden key in the whole response (leaked: ${leaked.join(",") || "none"})`);
check(
  !raw.includes("3850") && !String(view.body?.explain ?? "").includes("3,850"),
  "the unbilled contract ($3,850) appears nowhere, in a key OR the sentence",
);
check(
  !String(view.body?.explain ?? "").toLowerCase().includes("contract"),
  "the crew sentence never mentions the contract",
);

// ── 6. the wall it does NOT open ─────────────────────────────────────────
console.log("\n6. switching profit on does not open anything else");
const stillWalled = await crew("GET", `/api/jobs/${job.id}/costing`, undefined, [403]);
check(
  stillWalled.body?.error?.code === "department_forbidden",
  "/costing is still refused with the setting ON",
);
const wip = await crew("GET", "/api/wip", undefined, [403]);
check(wip.status === 403, `the portfolio WIP report is still refused (got ${wip.status})`);

// ── 7. and the owner is NOT redacted by their own setting ────────────────
console.log("\n7. the owner still sees the full view with the setting on");
const ownerAgain = await owner("GET", `/api/jobs/${job.id}/profit`, undefined, [200]);
check(
  ownerAgain.body?.view === "full",
  `owner view is still "full" (got ${ownerAgain.body?.view})`,
);
// The bug this catches: restating the department rule in the profit route and
// forgetting that owner/admin implicitly hold every wall. It would hand the
// owner the crew view of their own job, and it would read as "the feature is
// broken" rather than as an authz error.
check(
  typeof ownerAgain.body?.profit?.collectedProfitCents === "number",
  "and still gets collected profit",
);

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
console.log("JOB PROFIT VISIBILITY PROVEN\n");
