/**
 * Revise-before-approve proof — the words a person types are the words that
 * go out, and an "edit" cannot quietly become a different action.
 *
 * The approval gate merges a client-supplied `edit` object over the action's
 * payload and executes the result. That is the right design — a human must be
 * able to reword a payment reminder before it reaches a customer — and it is
 * also the sharpest edge in the whole agent layer, because `edit` used to be
 * an open record. An approver could rewrite the ids that decide WHICH invoice
 * gets chased, while `agent_actions.payload` — the column a reviewer reads —
 * still named the original. The action on file and the action that ran would
 * stop being the same thing.
 *
 * So this proves both halves:
 *   - a revision to an OPENED field actually changes what the customer gets
 *   - a revision to any other field is refused, by name
 *
 *   pnpm dev                              # AUTH_MODE=dev
 *   node scripts/revise-gate-proof.mjs
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
let cookie = "";
async function call(method, path, json, expect) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie,
      origin: BASE,
      "content-type": "application/json",
      "idempotency-key": `rev-${Math.random().toString(36).slice(2)}-${Date.now()}`,
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
}

/**
 * A read as the app sees it.
 *
 * ⛔ agent_actions carries a RESTRICTIVE department policy (migration 0029),
 * so a tenant GUC alone returns ZERO ROWS on a dunning card — the wall is in
 * the DATABASE, not just the route. A probe that set only the tenant would
 * report "no such action" on an action that plainly exists, which is the same
 * shape of false negative that once hid a dead customer portal.
 */
async function scoped(sql, params = []) {
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
  await db.query("SELECT set_config('app.current_departments', 'financials,field,hr', true)");
  const r = await db.query(sql, params);
  await db.query("COMMIT");
  return r;
}

// ── a shop with an invoice old enough to chase ───────────────────────────
await call("POST", "/api/auth/dev-login", { email: `rev-${stamp}@example.com` }, [200]);
const signup = await call(
  "POST",
  "/api/auth/signup",
  { name: `Revise Proof ${stamp}`, slug: `rev-proof-${stamp}` },
  [200, 201],
);
const tenant = signup.body?.tenantId ?? signup.body?.id;

const job = (
  await call("POST", "/api/jobs", {
    customerName: "Dana Overdue",
    customerPhone: "+15551230001",
    name: "Revise proof job",
    contractCents: 500000,
    budgetCents: 300000,
  }, [200, 201])
).body;

const today = new Date().toISOString().slice(0, 10);
await call("POST", `/api/jobs/${job.id}/invoices`, {
  subtotalCents: 250000,
  issuedOn: today,
  memo: "Progress billing",
}, [200, 201]);

// Age it past the 30-day threshold the Front Desk uses.
await scoped(
  `UPDATE invoices SET issued_on = (now() - interval '45 days')::date
    WHERE job_id = $1`,
  [job.id],
);
console.log(`tenant rev-proof-${stamp}: one invoice, 45 days open\n`);

// ── 1. the helper drafts a reminder, and the queue shows the WORDS ───────
console.log("1. the Front Desk drafts a reminder and the queue shows its words");
// The Front Desk is OFF by default — a shop decides when a helper starts
// drafting messages in its name. Switching it to ask-first is part of the
// story this proves, not setup noise.
await call("PUT", "/api/agents/policies", { agentKey: "crm", mode: "approve" }, [200, 201]);
const run = await call("POST", "/api/agents/crm/run", {}, [200]);
check(
  (run.body?.dunningProposed ?? 0) >= 1,
  `a payment reminder was drafted (got ${run.body?.dunningProposed})`,
);

const inbox = await call("GET", "/api/approvals", undefined, [200]);
const cards = (inbox.body?.groups ?? []).flatMap((g) => g.items);
const card = cards.find((i) => i.kind === "ar.dunningDraft");
check(Boolean(card), `the dunning card is in the approvals queue`);
check(
  typeof card?.editable?.message === "string" && card.editable.message.length > 10,
  "the card carries the editable message, not just a summary",
);

// The card must NOT ship the whole payload to the browser. A dunning payload
// carries the customer name, invoice number and open balance; the screen needs
// one field, so it gets one field.
check(
  Object.keys(card?.editable ?? {}).join(",") === "message",
  `exactly one editable field (got ${Object.keys(card?.editable ?? {}).join(",") || "none"})`,
);

// ── 2. a revision cannot retarget the action ─────────────────────────────
console.log("\n2. an 'edit' cannot become a different action");
const otherJob = (
  await call("POST", "/api/jobs", {
    customerName: "Someone Else",
    name: "Other job",
    contractCents: 100000,
    budgetCents: 100000,
  }, [200, 201])
).body;
const otherInv = await call("POST", `/api/jobs/${otherJob.id}/invoices`, {
  subtotalCents: 999900,
  issuedOn: today,
}, [200, 201]);
const otherInvoiceId = otherInv.body?.id ?? otherInv.body?.invoiceId;

const retarget = await call(
  "POST",
  `/api/agents/actions/${card.actionId}/decide`,
  { type: "revise", edit: { invoiceId: otherInvoiceId ?? "00000000-0000-0000-0000-000000000000" } },
  [422],
);
check(
  String(retarget.body?.error?.code ?? "").startsWith("field_not_revisable"),
  `retargeting the invoice is refused BY NAME (got ${retarget.body?.error?.code})`,
);

const sneak = await call(
  "POST",
  `/api/agents/actions/${card.actionId}/decide`,
  { type: "revise", edit: { message: "Fine.", invoiceId: otherInvoiceId } },
  [422],
);
check(
  String(sneak.body?.error?.code ?? "").startsWith("field_not_revisable"),
  "a forbidden field alongside an allowed one rejects the WHOLE edit",
);

const empty = await call(
  "POST",
  `/api/agents/actions/${card.actionId}/decide`,
  { type: "revise", edit: {} },
  [422],
);
check(
  empty.body?.error?.code === "empty_revision",
  `an empty revision is refused (got ${empty.body?.error?.code})`,
);

// Every refusal above must have left the card decidable.
const stillOpen = await scoped(
  `SELECT status FROM agent_actions WHERE id = $1`,
  [card.actionId],
);
check(
  stillOpen.rows[0]?.status === "proposed",
  `after three refusals the card is still waiting (got ${stillOpen.rows[0]?.status})`,
);

// ── 3. the words a person types are the words that go out ────────────────
console.log("\n3. a reworded reminder sends the human's words");
const MINE = `Hi Dana, invoice is still open from last month. Give me a shout when you get a chance and we'll sort it out.`;
const revised = await call(
  "POST",
  `/api/agents/actions/${card.actionId}/decide`,
  { type: "revise", edit: { message: MINE } },
  [200],
);
check(revised.body?.status === "executed", `the revision executed (got ${revised.body?.status})`);

const stored = await scoped(
  `SELECT status, payload, edit FROM agent_actions WHERE id = $1`,
  [card.actionId],
);
const row = stored.rows[0];
check(row?.status === "executed", "the action is recorded as executed");
check(
  row?.edit?.message === MINE,
  "the human's wording is stored as the EDIT, so the audit shows what changed",
);
check(
  row?.payload?.message !== MINE && typeof row?.payload?.message === "string",
  "and the helper's original wording is still on file, unmodified",
);

// The executor received the merged payload — and it landed on the invoice the
// card named, not the one the rejected edits tried to point it at.
const sent = await scoped(
  `SELECT name FROM events WHERE subject_id = $1 AND name LIKE 'dunning%'
    ORDER BY occurred_at DESC LIMIT 1`,
  [String(row.payload.invoiceId)],
);
check(
  sent.rows.length === 1,
  `the reminder landed on the ORIGINAL invoice (got ${sent.rows.length} event(s))`,
);
// No SMS/email transport is configured locally, so this records rather than
// sends. What is being proven here is WHICH invoice it hit, not the carrier.
check(
  String(sent.rows[0]?.name ?? "").startsWith("dunning"),
  `and it is a dunning event (got ${sent.rows[0]?.name})`,
);
const otherTouched = await scoped(
  `SELECT count(*)::int AS n FROM events
    WHERE subject_id = $1 AND name LIKE 'dunning%'`,
  [String(otherInvoiceId)],
);
check(
  otherTouched.rows[0]?.n === 0,
  `the invoice the rejected edit pointed at was never touched (got ${otherTouched.rows[0]?.n})`,
);

// ── 4. it is decided, once ───────────────────────────────────────────────
console.log("\n4. a decided card cannot be decided again");
const again = await call(
  "POST",
  `/api/agents/actions/${card.actionId}/decide`,
  { type: "approve" },
  [409],
);
check(
  again.body?.error?.code === "already_decided",
  `a second decision is refused (got ${again.body?.error?.code})`,
);

// ── clean up ─────────────────────────────────────────────────────────────
//
// ⛔ The department GUC matters here too, and the reason is worth knowing.
// `app.purge_current_tenant()` sweeps and then VERIFIES that nothing remains —
// but both the DELETE and the verifying COUNT run under RLS, so the function
// can only confirm the absence of rows it is able to see. Purging with an
// empty department scope leaves the `agent_actions` rows behind, the verify
// counts zero, and the final `DELETE FROM tenants` throws a raw foreign-key
// error instead of the function's own "purge incomplete" message.
//
// Production is safe by construction: `resolveScope` expands an owner's grants
// to every department key in the tenant, and the only keys that ever tag a row
// are the three standard ones, which cannot be deleted. `agents/editable.test`
// and `auth-tenancy/department-tags.test` pin that invariant.
await db.query("BEGIN");
await db.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
await db.query("SELECT set_config('app.current_departments', 'financials,field,hr', true)");
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
console.log("REVISE GATE PROVEN\n");
