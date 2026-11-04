/**
 * Endpoint sweep — drives the WHOLE business loop through the real HTTP API on
 * a scratch tenant, asserts every step, then fails if any route file exists
 * that the sweep never touched.
 *
 * The coverage gate is the point. A suite that only tests what someone
 * remembered to add decays silently: the next endpoint ships untested and
 * nothing complains. Here, adding a route to src/app/api and not covering it
 * BREAKS the sweep, so coverage cannot rot without somebody noticing.
 *
 * Runs against a dev-mode server (AUTH_MODE=dev) so it can log in without
 * Identity Platform, and creates its own tenant so it can delete everything it
 * made. It never touches an existing tenant.
 *
 *   pnpm dev                        # in one terminal
 *   node scripts/endpoint-sweep.mjs # in another
 */
import { readdirSync, statSync } from "node:fs";
import { Client } from "pg";
import { join, relative, sep } from "node:path";
import { attributeCoverage, bare, strayCalls } from "./lib/coverage.mjs";

const BASE = process.env.SWEEP_BASE ?? "http://localhost:5150";
const API_DIR = join(process.cwd(), "src", "app", "api");

let pass = 0;
const failures = [];
/** Route paths the sweep exercised, normalised to their file-route pattern. */
const touched = new Set();
let cookie = "";

// ─────────────────────────────────────────────────────────────── plumbing
// Coverage attribution lives in scripts/lib/coverage.mjs so it can be unit
// tested (test/coverage-matcher.test.ts). It is the one part of this script
// whose correctness is not obvious from reading the output — and it was
// silently broken for every dynamic segment not named `[id]`.

async function call(method, path, { json, form, expect = [200, 201], label } = {}) {
  const name = label ?? `${method} ${path}`;
  // The proxy's CSRF guard is fail-CLOSED (a POST with neither
  // Sec-Fetch-Site nor Origin is refused). Node's fetch sends neither, so the
  // sweep states its origin explicitly — the same thing a browser does.
  const headers = { cookie, origin: BASE };
  let body;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = `sweep-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
  } catch (err) {
    failures.push(`${name} — request failed: ${err.message}`);
    return null;
  }
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];

  touched.add(bare(path));
  const ok = expect.includes(res.status);
  const payload = await res.json().catch(() => null);
  if (ok) {
    pass++;
    console.log(`  ok   ${name} -> ${res.status}`);
  } else {
    failures.push(
      `${name} -> ${res.status} (wanted ${expect.join("/")}) ${JSON.stringify(payload)?.slice(0, 160)}`,
    );
    console.log(`  FAIL ${name} -> ${res.status}`);
  }
  return payload;
}

/**
 * Assert a route REFUSES an aal1 session with exactly aal2_required.
 *
 * Dev login is aal1 on purpose ("dev logins NEVER claim a second factor"), so
 * these can't be driven end-to-end here — but proving they refuse is the more
 * valuable assertion anyway: it is the step-up gate working, verified, rather
 * than assumed. Any other status (200 especially) is a real failure.
 */
async function assertStepUp(method, path, json) {
  const name = `${method} ${path} [step-up gate]`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie,
      origin: BASE,
      "content-type": "application/json",
      "idempotency-key": `sweep-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  touched.add(bare(path));
  const payload = await res.json().catch(() => null);
  if (res.status === 403 && payload?.error?.code === "aal2_required") {
    pass++;
    console.log(`  ok   ${name} -> 403 aal2_required (enforced)`);
  } else {
    failures.push(`${name} -> ${res.status} ${JSON.stringify(payload)?.slice(0, 120)} — expected 403 aal2_required`);
    console.log(`  FAIL ${name} -> ${res.status}`);
  }
}

function step(title) {
  console.log(`\n${title}`);
}

/**
 * A bank account, written the way `createBankAccount` writes it, through the
 * OWNER connection the teardown already requires. Creating one through the
 * API is aal2-gated (asserted where it's called) and dev logins never claim
 * a second factor — which had quietly turned the whole downstream bank loop
 * (import, categorize, recategorize, posted, reconcile) into dead code
 * behind `const acct = null`. A fixture is honest where an exemption is
 * not: the ROUTES still get exercised; only the one aal2 door is opened
 * from the side.
 */
async function bankAccountFixture(name) {
  if (!process.env.MIGRATE_DATABASE_URL) return null;
  const admin = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
  await admin.connect();
  try {
    const t = await admin.query(
      "SELECT id FROM tenants WHERE slug LIKE 'sweep-%' ORDER BY created_at DESC LIMIT 1",
    );
    const tenantId = t.rows[0]?.id;
    if (!tenantId) return null;
    await admin.query("SELECT set_config('app.current_tenant', $1, false)", [tenantId]);
    const { rows } = await admin.query(
      `INSERT INTO bank_accounts (tenant_id, name, gl_account_code, kind, charges_are_positive)
       VALUES ($1, $2, '1020', 'checking', false) RETURNING id`,
      [tenantId, name],
    );
    await admin.query("SELECT set_config('app.current_tenant', '', false)");
    return { id: rows[0].id };
  } finally {
    await admin.end();
  }
}

// ─────────────────────────────────────────────────────── the business loop
const stamp = Date.now();
// Monday of this week — the dispatch board and the time week both key on it.
const monday = (() => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
})();

step("AUTH — dev login + fresh tenant");
await call("POST", "/api/auth/dev-login", { json: { email: `sweep-${stamp}@example.com` } });
const signup = await call("POST", "/api/auth/signup", {
  json: { name: `Sweep Co ${stamp}`, slug: `sweep-${stamp}` },
  expect: [200, 201],
});
if (!signup) {
  console.error("\nCannot continue without a tenant.");
  process.exit(1);
}
await call("GET", "/api/me");
await call("GET", "/api/auth/config");
await call("POST", "/api/auth/select-tenant", {
  json: { tenantId: signup.tenantId ?? signup.id },
  expect: [200, 400, 403],
});

step("SETUP — departments, pricebook, vendor, worker");
await call("GET", "/api/team");
// Custom department + assignment: the "fits how any company runs" path.
await assertStepUp("POST", "/api/team", {
  action: "create-department",
  key: "install-crews",
  name: "Install crews",
});
const pb = await call("POST", "/api/pricebook", {
  json: {
    code: `SWEEP-${stamp}`,
    name: "3-ton change-out",
    unitPriceCents: 785000,
    unit: "system",
    category: "Cooling",
  },
  expect: [200, 201],
});
await call("GET", "/api/pricebook");
const vendor = await call("POST", "/api/vendors", {
  json: { name: `Sweep Supply ${stamp}`, is1099: false },
  expect: [200, 201],
});
await call("GET", "/api/vendors");
await call("POST", "/api/workforce/workers", {
  json: { type: "wc-class", classCode: "5538", description: "HVAC", ratePer100Cents: 620 },
  expect: [200, 201],
  label: "POST /api/workforce/workers (wc-class)",
});
const worker = await call("POST", "/api/workforce/workers", {
  json: { type: "worker", name: "Sweep Tech", wcClassCode: "5538", baseHourlyCents: 3200 },
  expect: [200, 201],
  label: "POST /api/workforce/workers (worker)",
});
await call("GET", "/api/workforce/workers");
await call("GET", "/api/workforce/roster");

// The cost-code chart: seed a whole trade preset, then hand-add one code —
// the two ways a real shop ever builds it.
await call("GET", "/api/cost-codes");
await call("POST", "/api/cost-codes", {
  json: { action: "seed", preset: "hvac" },
  expect: [200, 201],
  label: "POST /api/cost-codes (seed hvac preset)",
});
await call("POST", "/api/cost-codes", {
  json: { action: "upsert", code: "9990", name: "Sweep special works", kind: "other" },
  expect: [200, 201],
  label: "POST /api/cost-codes (upsert one)",
});

step("CUSTOMER + JOB");
// A job CREATES its customer (customerName, find-or-create) — /api/customers
// POST is portal-link management, not customer creation.
const job = await call("POST", "/api/jobs", {
  json: {
    customerName: `Sweep Customer ${stamp}`,
    name: "Sweep AC replacement",
    jobType: "retail",
    contractCents: 985000,
    budgetCents: 620000,
  },
  expect: [200, 201],
});
const custList = await call("GET", "/api/customers");
const cust = custList?.customers?.[0];
if (cust?.id) {
  await call("POST", "/api/customers", {
    json: { action: "portal-link", customerId: cust.id },
    expect: [200, 201],
  });
}
await call("GET", "/api/jobs");
if (job?.id) await call("GET", `/api/jobs/${job.id}`);

step("SALES — territory pins + opportunity lifecycle");
if (cust?.id) {
  const opp = await call("POST", "/api/sales/opportunities", {
    json: { customerId: cust.id, title: "Sweep opportunity", valueCents: 120000 },
    expect: [201],
  });
  await call("GET", `/api/sales/opportunities?customerId=${cust.id}`);
  if (opp?.id) {
    await call("POST", `/api/sales/opportunities/${opp.id}/stage`, {
      json: { stage: "qualify" },
    });
    // lost without a reason must be REFUSED — the human-message 422, backed
    // by the DB CHECK
    await call("POST", `/api/sales/opportunities/${opp.id}/stage`, {
      json: { stage: "lost" },
      expect: [422],
    });
    await call("POST", `/api/sales/opportunities/${opp.id}/stage`, {
      json: { stage: "lost", lostReason: "sweep: price" },
    });
    // a closed opportunity cannot advance again
    await call("POST", `/api/sales/opportunities/${opp.id}/stage`, {
      json: { stage: "qualify" },
      expect: [409],
    });
  }
}

await call("GET", "/api/sales/targets");
if (cust?.id) {
  await call("POST", "/api/sales/targets", {
    json: { customerId: cust.id, signalKey: "gone-quiet", disposition: "snoozed", days: 30 },
  });
  await call("POST", "/api/sales/targets", {
    json: { customerId: cust.id, signalKey: "gone-quiet", disposition: "bury-it" },
    expect: [422],
    label: "POST /api/sales/targets (bad disposition refused)",
  });
}

step("ESTIMATE — build, approve");
const est = await call("POST", `/api/jobs/${job?.id}/estimates`, {
  json: {
    options: [
      {
        tier: "better",
        title: "Better",
        summary: "Most popular",
        lines: [
          { description: "3-ton change-out", qtyX100: 100, unitPriceCents: 785000, pricebookItemId: pb?.id },
          { description: "Crane day (one-off)", qtyX100: 100, unitPriceCents: 185000 },
        ],
      },
    ],
  },
  expect: [200, 201],
});
if (est?.options?.[0]?.id) {
  const awarded = await call("POST", `/api/estimates/${est.id}/approve`, {
    json: { optionId: est.options[0].id },
  });

  // ── THE DATA-LOSS REGRESSION (migration 0043) ─────────────────────────
  // Approving a SECOND estimate used to silently overwrite the first
  // contract value — no record it ever existed, every downstream number
  // (percent-complete, earned revenue, over/under-billing, the CPA pack)
  // quietly re-based. It was reachable from the customer PORTAL, at aal1,
  // with no financials wall. Changing an awarded contract is a change
  // order now, and a second award is refused.
  const second = await call("POST", `/api/jobs/${job?.id}/estimates`, {
    json: {
      options: [
        {
          tier: "best",
          title: "Best",
          lines: [{ description: "Different scope", qtyX100: 100, unitPriceCents: 100000 }],
        },
      ],
    },
    expect: [200, 201],
    label: "POST /api/jobs/[id]/estimates (a second estimate on the same job)",
  });
  if (second?.options?.[0]?.id) {
    await call("POST", `/api/estimates/${second.id}/approve`, {
      json: { optionId: second.options[0].id },
      expect: [409],
      label: "POST /api/estimates/[id]/approve (second award -> 409, contract protected)",
    });
  }
  // …and the original contract is still the original contract.
  const after = await call("GET", `/api/jobs/${job?.id}`, {
    label: "GET /api/jobs/[id] (contract survived the second approval)",
  });
  const contractAfter = Number(after?.job?.contract_cents ?? -1);
  if (awarded && contractAfter !== awarded.contractCents) {
    failures.push(
      `CONTRACT CLOBBERED: awarded ${awarded.contractCents}, now ${contractAfter}`,
    );
  }
}

step("DISPATCH + FIELD");
const appt = await call("POST", "/api/dispatch", {
  json: {
    jobId: job?.id,
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    endsAt: new Date(Date.now() + 90_000_000).toISOString(),
  },
  expect: [200, 201],
});
await call("GET", `/api/dispatch?weekStart=${monday}`);
if (appt?.id && worker?.id) {
  await call("POST", "/api/dispatch/assign", {
    json: { appointmentId: appt.id, workerId: worker.id },
    expect: [200, 201, 409],
  });
}
await call("POST", `/api/jobs/${job?.id}/costs`, {
  json: {
    costCode: "4100",
    kind: "material",
    amountCents: 128000,
    occurredOn: new Date().toISOString().slice(0, 10),
    memo: "Line set + pad",
  },
  expect: [200, 201],
});
await call("GET", `/api/jobs/${job?.id}/costing`);
await call("POST", `/api/jobs/${job?.id}/status`, {
  json: { status: "in-progress" },
  expect: [200, 409],
});

step("JOB EDIT — correct a booked job, and light up the depreciation nudge");
// ⛔ The assertion that matters is the NUDGE, not the route. Before this,
// `/api/jobs/[id]` had only a GET: RCV is settled AFTER an insurance job is
// booked, so `pending_depreciation_nudges` could never fire, and
// `depreciation_invoiced` had no writer anywhere, so one that did fire could
// never be dismissed. A 200 from PATCH proves plumbing; the nudge going on and
// then off proves the feature the product actually sells.
const insJob = await call("POST", "/api/jobs", {
  json: {
    customerName: `Sweep Insurance ${stamp}`,
    name: "Hail damage — full roof",
    jobType: "insurance-restoration",
    claimNumber: `CLM-${stamp}`,
    carrier: "State Farm",
    // The three columns that had no writer at all until now.
    adjusterName: "Dana Reyes",
    adjusterPhone: "602-555-0148",
    deductibleCents: 100_000,
  },
  expect: [200, 201],
  label: "POST /api/jobs (insurance, with the formerly-unreachable fields)",
});
if (insJob?.id) {
  // An unknown/forbidden key must be REFUSED, not silently dropped. Moving the
  // contract belongs to estimate approval + change orders (migration 0043's
  // tie-out trigger); a permissive schema would 200 and change nothing.
  await call("PATCH", `/api/jobs/${insJob.id}`, {
    json: { contractCents: 999_999 },
    expect: [400],
    label: "PATCH /api/jobs/[id] (contractCents REFUSED, not ignored)",
  });
  await call("PATCH", `/api/jobs/${insJob.id}`, {
    json: { status: "complete" },
    expect: [400],
    label: "PATCH /api/jobs/[id] (status refused — it has its own route)",
  });

  await call("POST", `/api/jobs/${insJob.id}/status`, {
    json: { status: "complete", completedOn: new Date().toISOString().slice(0, 10) },
    expect: [200, 201],
    label: "POST /api/jobs/[id]/status (complete)",
  });

  // RCV arrives now — the whole reason this route had to exist.
  const withRcv = await call("PATCH", `/api/jobs/${insJob.id}`, {
    json: { rcvCents: 1_240_000, acvCents: 890_000 },
    label: "PATCH /api/jobs/[id] (RCV settled after booking)",
  });
  if (withRcv && withRcv.depreciationNudge !== true) {
    failures.push(
      `depreciation nudge: expected TRUE after setting rcvCents on a completed insurance job, got ${JSON.stringify(withRcv.depreciationNudge)}`,
    );
  } else if (withRcv) {
    console.log("  ok   depreciation nudge FIRED once RCV was recorded");
    pass++;
  }

  // ...and can now be dismissed, which nothing in the product could do before.
  const dismissed = await call("PATCH", `/api/jobs/${insJob.id}`, {
    json: { depreciationInvoiced: true },
    label: "PATCH /api/jobs/[id] (depreciation invoiced)",
  });
  if (dismissed && dismissed.depreciationNudge !== false) {
    failures.push(
      `depreciation nudge: expected FALSE after depreciationInvoiced=true, got ${JSON.stringify(dismissed.depreciationNudge)}`,
    );
  } else if (dismissed) {
    console.log("  ok   depreciation nudge CLEARED once invoiced (both halves work)");
    pass++;
  }

  // An empty patch is a 422, not a silent success.
  await call("PATCH", `/api/jobs/${insJob.id}`, {
    json: {},
    expect: [422],
    label: "PATCH /api/jobs/[id] (empty patch -> 422)",
  });
}

step("TIME — log, post the week");
await call("POST", "/api/workforce/time", {
  json: {
    workerId: worker?.id,
    jobId: job?.id,
    workDate: monday,
    hoursX100: 800,
    costCode: "4200",
  },
  expect: [200, 201],
});
await call("GET", "/api/workforce/time");
await assertStepUp("POST", "/api/workforce/post-week", {
  workerId: worker?.id,
  weekStart: monday,
});

step("PURCHASING — PO, bill, partial + full payment");
const po = await call("POST", `/api/jobs/${job?.id}/pos`, {
  json: {
    kind: "po",
    vendorName: `Sweep Supply ${stamp}`,
    description: "Condenser + coil",
    amountCents: 289400,
  },
  expect: [200, 201],
});
if (po?.id) {
  await call("POST", `/api/pos/${po.id}/status`, {
    json: { status: "received" },
    expect: [200, 409],
  });
}
const bill = await call("POST", "/api/bills", {
  json: {
    vendorId: vendor?.id,
    issuedOn: new Date().toISOString().slice(0, 10),
    memo: "Condenser + coil",
    lines: [{ amountCents: 289400, jobId: job?.id, costCode: "4100", costKind: "material" }],
  },
  expect: [200, 201],
});
await call("GET", "/api/bills");
if (bill?.id) {
  await call("GET", `/api/bills/${bill.id}`);
  // Partial, then the rest — the path Cory asked for.
  await call("POST", `/api/bills/${bill.id}/pay`, {
    json: { paidOn: new Date().toISOString().slice(0, 10), amountCents: 100000, method: "check", reference: "1001" },
    label: "POST /api/bills/[id]/pay (partial)",
  });
  await call("POST", `/api/bills/${bill.id}/pay`, {
    json: { paidOn: new Date().toISOString().slice(0, 10), amountCents: 189400, method: "ach" },
    label: "POST /api/bills/[id]/pay (rest)",
  });
}

step("INVOICE — issue, record payment");
const inv = await call("POST", `/api/jobs/${job?.id}/invoices`, {
  json: {
    subtotalCents: 985000,
    retainageBps: 0,
    materialsCostCents: 289400,
    memo: "AC replacement",
    issuedOn: new Date().toISOString().slice(0, 10),
  },
  expect: [200, 201],
});
if (inv?.id) {
  await call("GET", `/api/jobs/${job?.id}/invoices`);
  await call("POST", `/api/invoices/${inv.id}/payments`, {
    json: {
      amountCents: 985000,
      method: "check",
      reference: "5001",
      receivedOn: new Date().toISOString().slice(0, 10),
    },
    expect: [200, 201],
  });
}

step("INVENTORY");
const item = await call("POST", "/api/inventory/items", {
  json: { name: `Capacitor 45/5 ${stamp}`, unit: "each", reorderPointX100: 400, reorderQtyX100: 1200 },
  expect: [200, 201],
});
await call("GET", "/api/inventory/items");
if (item?.id) {
  await call("POST", "/api/inventory/moves", {
    json: {
      type: "receive",
      itemId: item.id,
      qtyX100: 2400,
      unitCostCents: 3800,
      vendorName: `Sweep Supply ${stamp}`,
      occurredOn: new Date().toISOString().slice(0, 10),
    },
    expect: [200, 201],
  });
}

step("BANK — account, feeds, categorize, recategorize, posted, reconcile");
await assertStepUp("POST", "/api/bank/accounts", {
  name: "Operating",
  accountCode: "1020",
  last4: "4471",
});
await call("GET", "/api/bank/accounts");

// Feeds need no account: the connection list + provider matrix, a sync
// against a connection that does not exist, and the aal2 wall on
// disconnect (account-level changes step up; a refresh button never does).
await call("GET", "/api/bank/feeds");
await call("POST", "/api/bank/feeds", {
  json: { action: "sync", connectionId: "00000000-0000-4000-8000-000000000000" },
  expect: [404],
  label: "POST /api/bank/feeds (sync unknown -> 404)",
});
await assertStepUp("POST", "/api/bank/feeds", {
  action: "disconnect",
  connectionId: "00000000-0000-4000-8000-000000000000",
});

const acct = await bankAccountFixture(`Sweep Operating ${stamp}`);
if (!acct) {
  failures.push(
    "BANK loop skipped — set MIGRATE_DATABASE_URL so the fixture can create the account the aal2 gate refuses at aal1",
  );
}
if (acct?.id) {
  const csv = [
    "Date,Description,Amount",
    `${new Date().toISOString().slice(0, 10)},SWEEP SUPPLY PURCHASE,-2894.00`,
    `${new Date().toISOString().slice(0, 10)},CUSTOMER DEPOSIT,9850.00`,
  ].join("\n");
  const form = new FormData();
  form.set("bankAccountId", acct.id);
  form.set("file", new File([csv], "sweep.csv", { type: "text/csv" }));
  await call("POST", "/api/bank/import", { form, expect: [200, 201] });
  // The picker's options. Every shop coming off QuickBooks picks a category
  // by name, so this list is on the critical path for categorizing anything.
  await call("GET", "/api/bank/categories");

  const txns = await call("GET", "/api/bank/txns?status=pending");
  const first = txns?.txns?.[0];
  if (first?.id) {
    // The body is a discriminated union on `type` — it was `action` here,
    // which the route rejects with a 400 the expect-list did not allow.
    await call("POST", `/api/bank/txns/${first.id}/resolve`, {
      json: { type: "expense", accountCode: "8310" },
      expect: [200, 201, 409, 422],
    });

    // ...then CHANGE it, which is the half that was missing until now:
    // reverse the entry that was just posted and post a different one.
    await call("POST", `/api/bank/txns/${first.id}/recategorize`, {
      json: {
        action: { type: "expense", accountCode: "8320" },
        reason: "Sweep: proving a posted line can be recoded",
      },
      expect: [200, 409, 422],
    });
    await call("GET", `/api/bank/txns/${first.id}/recategorize`);
  }
  await call("GET", "/api/bank/posted");
  await call("POST", "/api/bank/reconcile", {
    json: { bankAccountId: acct.id, statementEndingCents: 695600, periodEnd: new Date().toISOString().slice(0, 10) },
    expect: [200, 409, 422],
  });
}

step("AGENTS — policy, run, approvals inbox");
await call("GET", "/api/agents/overview");
await call("PUT", "/api/agents/policies", {
  json: { agentKey: "financials", mode: "approve" },
  expect: [200, 201],
});
await call("POST", "/api/agents/financials/run", { json: {}, expect: [200, 201, 409] });
await call("POST", "/api/agents/echo/run", {
  json: {},
  expect: [200, 201, 409],
});
for (const a of ["documents", "workforce", "inventory", "dispatch", "booking", "crm", "sales"]) {
  await call("POST", `/api/agents/${a}/run`, { json: {}, expect: [200, 201, 409] });
}
const inbox = await call("GET", "/api/approvals");
const card = inbox?.groups?.flatMap((g) => g.items).find((i) => i.type === "decide");
if (card?.actionId) {
  await call("POST", `/api/agents/actions/${card.actionId}/decide`, {
    json: { type: "approve" },
    expect: [200, 409, 422],
  });
}

step("INTAKE");
const intake = await call("POST", "/api/intake", {
  json: {
    type: "manual",
    externalId: `sweep-${stamp}`,
    name: "Sweep Caller",
    phone: "6025550111",
    description: "No cooling upstairs",
    preferredWindow: "morning",
  },
  expect: [200, 201],
});
await call("GET", "/api/intake");
if (intake?.id) {
  await call("POST", "/api/intake", {
    json: { type: "status", intakeId: intake.id, status: "declined" },
    expect: [200, 409, 422],
  });
}

step("EQUIPMENT — the unit at the customer");
const unit = await call("POST", "/api/equipment", {
  json: {
    action: "create",
    customerId: cust?.id,
    label: "Upstairs unit",
    kind: "ac",
    make: "Goodman",
    model: "GSX140361",
    serial: `SW-${stamp}`,
  },
  expect: [200, 201],
});
await call("GET", `/api/equipment?customerId=${cust?.id}`);
await call("POST", "/api/equipment", {
  json: { action: "update", id: unit?.id, notes: "capacitor replaced during sweep" },
  expect: [200],
  label: "POST /api/equipment (update)",
});

step("MEMBERSHIPS — plan, enroll, visit lifecycle");
const plan = await call("POST", "/api/agreements", {
  json: {
    action: "create-plan",
    name: `Sweep Club ${stamp}`,
    billing: "annual",
    priceCents: 22900,
    visitsPerYear: 2,
    discountBps: 1500,
    targetMonths: [4, 10],
  },
  expect: [200, 201],
  label: "POST /api/agreements (create-plan)",
});
const enrollment = await call("POST", "/api/agreements", {
  json: {
    action: "enroll",
    planId: plan?.id,
    customerId: cust?.id,
    startOn: new Date().toISOString().slice(0, 10),
  },
  expect: [200, 201],
  label: "POST /api/agreements (enroll)",
});
await call("GET", "/api/agreements");
const visitList = await call("GET", "/api/agreements/visits?status=due");
const dueVisit = visitList?.visits?.[0];
if (dueVisit?.id) {
  // Completing a visit RELEASES deferred revenue — a money movement — so the
  // route gained aal2 in 0dc8aed (the rev-rec correctness fixes) and the gate
  // itself is now the assertion, same as the CPA pair. The $114.50-exact
  // release invariant this used to drive end-to-end lives on in the
  // agreements module's rev-rec oracle tests, where aal1 can't reach.
  await assertStepUp("POST", "/api/agreements/visits", {
    action: "complete",
    visitId: dueVisit.id,
    completedOn: new Date().toISOString().slice(0, 10),
  });
}
await call("POST", "/api/agreements", {
  json: { action: "cancel", agreementId: enrollment?.agreementId },
  expect: [200],
  label: "POST /api/agreements (cancel)",
});

step("CPA PAIR — all step-up gated (proving the gate IS the test)");
await assertStepUp("POST", "/api/credit-memos", {
  customerId: cust?.id,
  amountCents: 5000,
  reason: "sweep goodwill",
  issuedOn: new Date().toISOString().slice(0, 10),
});
await assertStepUp("POST", `/api/credit-memos/${"00000000-0000-4000-8000-000000000000"}/refund`, {
  method: "check",
  refundedOn: new Date().toISOString().slice(0, 10),
});
await assertStepUp("POST", `/api/invoices/${inv?.id}/void`, {
  voidedOn: new Date().toISOString().slice(0, 10),
});
await assertStepUp("POST", "/api/ledger/journal-entries", {
  occurredOn: new Date().toISOString().slice(0, 10),
  memo: "sweep accrual",
  lines: [
    { accountCode: "8310", debitCents: 1000 },
    { accountCode: "2425", creditCents: 1000 },
  ],
});
await call("GET", "/api/credit-memos", { expect: [200] });
await call("GET", "/api/invoices");
await call("GET", "/api/comms/settings");
await call("PATCH", "/api/comms/settings", {
  json: { reminderEnabled: true, googleReviewUrl: "https://g.page/r/sweep/review" },
  expect: [200],
});

step("CHANGE ORDERS — draft, send, approve, and the contract moves once");
const contract0 = await call("GET", `/api/jobs/${job?.id}/change-orders`);
const startedAt = contract0?.summary?.currentCents ?? 0;

const co = await call("POST", `/api/jobs/${job?.id}/change-orders`, {
  json: {
    title: "Extra return duct",
    reason: "Attic run was undersized; customer approved on site",
    lines: [{ description: "Return duct + grille", qtyX100: 100, unitPriceCents: 68000 }],
  },
  expect: [201],
});
// A DEDUCT is a negative unit price, not a separate concept.
const deduct = await call("POST", `/api/jobs/${job?.id}/change-orders`, {
  json: {
    title: "Drop the attic unit from scope",
    lines: [{ description: "Attic unit removed", qtyX100: 100, unitPriceCents: -95000 }],
  },
  expect: [201],
  label: "POST /api/jobs/[id]/change-orders (a DEDUCT)",
});
// A deduct bigger than the whole contract is a DOMAIN error with a sentence,
// not a raw 23514 from the contract_cents >= 0 CHECK.
await call("POST", `/api/jobs/${job?.id}/change-orders`, {
  json: {
    title: "Absurd deduct",
    lines: [{ description: "nope", qtyX100: 100, unitPriceCents: -99999999 }],
  },
  expect: [422],
  label: "POST /api/jobs/[id]/change-orders (deduct > contract -> 422)",
});

if (co?.id) {
  await call("POST", `/api/change-orders/${co.id}`, {
    json: { action: "send" },
    label: "POST /api/change-orders/[id] (send to customer)",
  });
  const approved = await call("POST", `/api/change-orders/${co.id}`, {
    json: { action: "approve" },
    label: "POST /api/change-orders/[id] (approve -> the contract moves)",
  });
  if (approved && Number(approved.contractCents) !== startedAt + 68000) {
    failures.push(
      `CHANGE ORDERS: contract should be ${startedAt + 68000}, got ${approved.contractCents}`,
    );
  }
  // Deciding twice must not move it twice.
  await call("POST", `/api/change-orders/${co.id}`, {
    json: { action: "approve" },
    expect: [409],
    label: "POST /api/change-orders/[id] (approve twice -> 409, no second movement)",
  });
  // Void is the destructive one, so it is step-up gated like an invoice void.
  await assertStepUp("POST", `/api/change-orders/${co.id}`, {
    action: "void",
    reason: "sweep",
  });
}
if (deduct?.id) {
  await call("POST", `/api/change-orders/${deduct.id}`, {
    json: { action: "decline", note: "customer changed their mind" },
    label: "POST /api/change-orders/[id] (decline)",
  });
}
// The ledger must agree with the cache, and the story must read in English.
const contract1 = await call("GET", `/api/jobs/${job?.id}/change-orders`, {
  label: "GET /api/jobs/[id]/change-orders (the contract story)",
});
if (contract1 && Number(contract1.summary.currentCents) !== startedAt + 68000) {
  failures.push(
    `CHANGE ORDERS: summary says ${contract1.summary.currentCents}, expected ${startedAt + 68000}`,
  );
}
if (contract1 && !/change order/i.test(contract1.explain ?? "")) {
  failures.push("CHANGE ORDERS: the explainer does not mention the change orders");
}

step("JOB PROFIT — the number, and who may see it");
// The sweep runs as an OWNER, so this is the full view. The redaction for a
// crew seat needs a second session and is proven end to end by
// scripts/profit-visibility-proof.mjs — 21 checks, including that the owner is
// NOT redacted by their own setting.
const profit = await call("GET", `/api/jobs/${job?.id}/profit`);
if (profit && profit.view !== "full") {
  failures.push(`JOB PROFIT: an owner got the "${profit.view}" view of their own job`);
}
// The two gross profits must both be present and must be named apart. A
// response carrying one unlabelled number is how a shop concludes the
// software cannot add up.
if (profit && (typeof profit.profit?.billedProfitCents !== "number" ||
               typeof profit.wip?.grossProfitCents !== "number")) {
  failures.push("JOB PROFIT: the response does not carry BOTH the billed profit and the WIP figure");
}

// Off by default — a disclosure a shop has to choose, never one it inherits.
const vis = await call("GET", "/api/settings/job-visibility");
if (vis && vis.crewSeesProfit !== false) {
  failures.push("JOB VISIBILITY: crew profit disclosure is ON by default — it must be opt-in");
}
// ⛔ The step-up gate. This is deliberately stricter than the house default
// (change orders approve at aal1): on a small job, labor cost divided by hours
// is a person's pay rate, so flipping it is a compensation decision.
await call("PATCH", "/api/settings/job-visibility", {
  json: { crewSeesProfit: true },
  expect: [403],
  label: "PATCH /api/settings/job-visibility (aal1 -> 403 aal2_required)",
});
const stillOff = await call("GET", "/api/settings/job-visibility");
if (stillOff && stillOff.crewSeesProfit !== false) {
  failures.push("JOB VISIBILITY: the refused PATCH changed the setting anyway");
}

step("JOB FORMS — templates, filling one in, and the completion gate");
// Off by default: a rule that can strand a crew at 6pm does not arrive
// because we shipped it.
const formSettings = await call("GET", "/api/settings/job-forms");
if (formSettings && formSettings.gateCompletion !== false) {
  failures.push("JOB FORMS: the completion gate is ON by default — it must be opt-in");
}

const tpl = await call("POST", "/api/form-templates", {
  json: {
    name: "Sweep startup check",
    description: "Filled in before the crew leaves",
    requiredForCompletion: true,
    items: [
      { kind: "check", label: "Power off at breaker", required: true },
      { kind: "number", label: "Torque check", required: true },
      { kind: "text", label: "Notes", required: false },
    ],
  },
  expect: [201],
});
// An item with no label is not a form item.
await call("POST", "/api/form-templates", {
  json: { name: "Bad", items: [{ kind: "check", label: "" }] },
  expect: [400],
  label: "POST /api/form-templates (unlabelled item -> 400)",
});
// The kind list is closed.
await call("POST", "/api/form-templates", {
  json: { name: "Bad", items: [{ kind: "hologram", label: "x" }] },
  expect: [400],
  label: "POST /api/form-templates (unknown item kind -> 400)",
});

if (tpl?.id && job?.id) {
  await call("PUT", `/api/form-templates/${tpl.id}`, {
    json: {
      name: "Sweep startup check",
      requiredForCompletion: true,
      items: [
        { kind: "number", label: "Torque check", required: true },
        { kind: "check", label: "Power off at breaker", required: true },
      ],
    },
    label: "PUT /api/form-templates/[id] (reordered, whole array)",
  });

  const attached = await call("POST", `/api/jobs/${job.id}/forms`, {
    json: { templateId: tpl.id },
    expect: [201],
  });
  // One of each template per job.
  await call("POST", `/api/jobs/${job.id}/forms`, {
    json: { templateId: tpl.id },
    expect: [409],
    label: "POST /api/jobs/[id]/forms (same template twice -> 409)",
  });

  const jobForms = await call("GET", `/api/jobs/${job.id}/forms`);
  const form = jobForms?.forms?.find((f) => f.id === attached?.id);
  if (!form) failures.push("JOB FORMS: the attached form did not come back");

  if (form) {
    // ⛔ Finishing is refused while a required item is unanswered, and the
    // refusal NAMES what is missing — the same rule the screen shows.
    const early = await call("POST", `/api/job-forms/${form.id}`, {
      json: { action: "complete" },
      expect: [422],
      label: "POST /api/job-forms/[id] (required items unanswered -> 422)",
    });
    if (!String(early?.error?.code ?? "").startsWith("form_incomplete")) {
      failures.push(`JOB FORMS: expected form_incomplete, got ${early?.error?.code}`);
    }

    const num = form.items.find((i) => i.kind === "number");
    const chk = form.items.find((i) => i.kind === "check");
    if (num) {
      // ⛔ ZERO is a real answer. A schema or a check that treats it as empty
      // makes "0 leaks found" impossible to record.
      await call("PATCH", `/api/job-form-items/${num.id}`, {
        json: { valueNumber: 0 },
        label: "PATCH /api/job-form-items/[id] (zero IS an answer)",
      });
    }
    if (chk) {
      await call("PATCH", `/api/job-form-items/${chk.id}`, { json: { checked: true } });
    }

    const after = await call("GET", `/api/jobs/${job.id}/forms`);
    const ready = after?.forms?.find((f) => f.id === form.id);
    if (ready && !ready.completeness?.canComplete) {
      failures.push(
        `JOB FORMS: still incomplete after answering everything required: ${ready.explain}`,
      );
    }

    await call("POST", `/api/job-forms/${form.id}`, { json: { action: "complete" } });
    // A finished form is closed to edits until somebody reopens it on purpose.
    if (chk) {
      await call("PATCH", `/api/job-form-items/${chk.id}`, {
        json: { checked: false },
        expect: [409],
        label: "PATCH /api/job-form-items/[id] (form finished -> 409)",
      });
    }
    await call("POST", `/api/job-forms/${form.id}`, {
      json: { action: "reopen" },
      label: "POST /api/job-forms/[id] (reopen)",
    });

    // ── the completion gate, switched on for real ──────────────────────
    await call("PATCH", "/api/settings/job-forms", { json: { gateCompletion: true } });
    const blocked = await call("POST", `/api/jobs/${job.id}/status`, {
      json: { status: "complete" },
      expect: [422],
      label: "POST /api/jobs/[id]/status (required form unfinished -> 422)",
    });
    if (!String(blocked?.error?.code ?? "").startsWith("forms_incomplete")) {
      failures.push(`JOB FORMS: gate returned ${blocked?.error?.code}, not forms_incomplete`);
    }
    // ⛔ Going BACKWARDS is never blocked. A rule that stops somebody undoing
    // a mistake is a rule that gets the whole feature switched off.
    await call("POST", `/api/jobs/${job.id}/status`, {
      json: { status: "in-progress" },
      label: "POST /api/jobs/[id]/status (backwards is never gated)",
    });
    // Finish the form and the same call now succeeds.
    await call("POST", `/api/job-forms/${form.id}`, { json: { action: "complete" } });
    await call("POST", `/api/jobs/${job.id}/status`, {
      json: { status: "complete" },
      label: "POST /api/jobs/[id]/status (form finished -> allowed)",
    });
    // Leave the shop as we found it.
    await call("PATCH", "/api/settings/job-forms", { json: { gateCompletion: false } });
    await call("POST", `/api/jobs/${job.id}/status`, { json: { status: "in-progress" } });
  }

  await call("PATCH", `/api/form-templates/${tpl.id}`, {
    json: { archived: true },
    label: "PATCH /api/form-templates/[id] (archive, never delete)",
  });
}

step("SELF-BOOKING — the switch, the public page, a real booking");
// Off by default: a shop must DECIDE to put a booking form on the internet.
const bookOff = await call("GET", "/api/booking/settings");
if (bookOff && bookOff.enabled !== false) {
  failures.push("SELF-BOOKING: online booking is ON by default — it must be opt-in");
}
// The public page must say so, without a session.
const publicOff = await call("GET", `/api/public/book/sweep-${stamp}`, {
  label: "GET /api/public/book/[slug] (disabled -> no slots)",
});
if (publicOff && (publicOff.enabled !== false || publicOff.days?.length)) {
  failures.push("SELF-BOOKING: a disabled shop still offered slots publicly");
}

await call("PATCH", "/api/booking/settings", {
  json: { enabled: true, daysOut: 14, minLeadHours: 0, intro: "Sweep test", timezone: "America/Phoenix" },
});
// A bad timezone is refused at the write, not at every later read.
await call("PATCH", "/api/booking/settings", {
  json: { timezone: "Mars/Olympus" },
  expect: [422],
  label: "PATCH /api/booking/settings (invalid timezone -> 422)",
});

const slots = await call("GET", `/api/public/book/sweep-${stamp}`, {
  label: "GET /api/public/book/[slug] (enabled -> real slots)",
});
const pick = slots?.days?.[0]?.windows?.[0];
if (!pick) {
  failures.push("SELF-BOOKING: no slots offered even with booking enabled and a worker active");
} else {
  const nonce = `sweep-book-${stamp}`;
  const booked = await call("POST", `/api/public/book/sweep-${stamp}`, {
    json: {
      name: "Sweep Homeowner",
      phone: "6025550188",
      address: "1 Test St",
      description: "Not cooling upstairs",
      nonce,
      startsAt: pick.startsAt,
      endsAt: pick.endsAt,
    },
    expect: [201],
    label: "POST /api/public/book/[slug] (a stranger books a real slot)",
  });
  // Same nonce again is the double-tap, not a second job.
  const again = await call("POST", `/api/public/book/sweep-${stamp}`, {
    json: {
      name: "Sweep Homeowner",
      phone: "6025550188",
      nonce,
      startsAt: pick.startsAt,
      endsAt: pick.endsAt,
    },
    expect: [201],
    label: "POST /api/public/book/[slug] (same nonce -> the SAME booking)",
  });
  // Number(), on both sides: pg returns a bigint as a string, so a raw !==
  // between the fresh path and the replay path compares 2 with "2" and
  // reports a double-booking that never happened.
  if (booked?.jobNo && again?.jobNo && Number(booked.jobNo) !== Number(again.jobNo)) {
    failures.push(
      `SELF-BOOKING: a repeated nonce booked twice (#${booked.jobNo} and #${again.jobNo})`,
    );
  }
  if (again && again.duplicate !== true) {
    failures.push("SELF-BOOKING: a repeated nonce was not reported as a duplicate");
  }
  // The honeypot looks exactly like success and writes nothing.
  await call("POST", `/api/public/book/sweep-${stamp}`, {
    json: {
      name: "Bot",
      website: "http://spam.example",
      nonce: `sweep-bot-${stamp}`,
      startsAt: pick.startsAt,
      endsAt: pick.endsAt,
    },
    expect: [201],
    label: "POST /api/public/book/[slug] (honeypot -> silent 201, nothing written)",
  });
}

step("INBOX — thread a customer, reply, note, polish, triage");
// A customer created by POST /api/jobs carries a NAME and nothing else, so
// there is nobody to message until contact details exist. That was a real gap
// the inbox exposed: no route in the product could add a phone number.
await call("POST", "/api/customers", {
  json: { action: "contact", customerId: cust?.id, phone: "(602) 555-0142" },
  label: "POST /api/customers (set contact details)",
});
// Starting a thread from a customer is find-or-create: calling it twice must
// return the SAME thread, or every "text this customer" click spawns another
// conversation and the history splits.
const thread1 = await call("POST", "/api/inbox", {
  json: { action: "open-for-customer", customerId: cust?.id },
  expect: [200, 201],
});
const thread2 = await call("POST", "/api/inbox", {
  json: { action: "open-for-customer", customerId: cust?.id },
  expect: [200, 201],
  label: "POST /api/inbox (same customer -> same thread)",
});
if (thread1?.id && thread2?.id && thread1.id !== thread2.id) {
  failures.push("INBOX: opening a thread twice for one customer made TWO threads");
}
await call("GET", "/api/inbox");
await call("GET", "/api/inbox?status=all");
if (thread1?.id) {
  await call("GET", `/api/inbox/${thread1.id}`);
  // No transports configured in dev, so an outbound TEXT correctly has
  // nowhere to go: 503 is the honest answer, not a silent success.
  await call("POST", `/api/inbox/${thread1.id}/messages`, {
    json: { body: "Running about 20 minutes behind, still coming.", channel: "auto" },
    expect: [503],
    label: "POST /api/inbox/[id]/messages (no transport -> fail closed)",
  });
  // ⛔ A draft with blanks in it never leaves the building. The reply box
  // greys out its send button, and this is the check that makes that TRUE —
  // a gate that lives only in a browser is a suggestion. Asserted on the NOTE
  // channel so the 422 cannot be confused with the transport 503 above.
  await call("POST", `/api/inbox/${thread1.id}/messages`, {
    json: { body: "I can be there [time] on [date].", channel: "note" },
    expect: [422],
    label: "POST /api/inbox/[id]/messages (unfilled [blanks] -> 422)",
  });
  // An internal note never touches a carrier, so it must work anyway.
  await call("POST", `/api/inbox/${thread1.id}/messages`, {
    json: { body: "Customer prefers afternoons.", channel: "note" },
    expect: [200, 201],
    label: "POST /api/inbox/[id]/messages (internal note)",
  });
  await call("PATCH", `/api/inbox/${thread1.id}`, {
    json: { action: "update", status: "closed" },
  });
  await call("PATCH", `/api/inbox/${thread1.id}`, {
    json: { action: "update", status: "open", markRead: true },
    label: "PATCH /api/inbox/[id] (reopen + mark read)",
  });
}
// The polish helper with no ANTHROPIC_API_KEY must refuse, not improvise.
await call("POST", "/api/assist/polish", {
  json: { text: "hey can be there tues 8am, part is 450" },
  expect: [503, 200],
  label: "POST /api/assist/polish (fail-closed without a key)",
});
// The surface is a CLOSED enum: it picks a prompt rule and decides whether the
// escalation gate runs, so a client must never be able to invent one. A free
// string here would be a way to ask for the ungated path on a dunning message.
await call("POST", "/api/assist/polish", {
  json: { text: "please pay invoice 1042", surface: "anything_goes" },
  expect: [400],
  label: "POST /api/assist/polish (unknown surface -> 400)",
});
await call("POST", "/api/assist/polish", {
  json: { text: "please pay invoice 1042", surface: "dunning" },
  expect: [503, 200],
  label: "POST /api/assist/polish (dunning surface accepted)",
});

// The voicemail drafter takes a MESSAGE ID, never a transcript — the server
// decides what the model reads. A route that accepted text would let a client
// feed the model anything and call the answer a draft of that voicemail.
await call("POST", "/api/assist/draft", {
  json: { transcript: "my ac is broken" },
  expect: [400],
  label: "POST /api/assist/draft (a transcript is not an id -> 400)",
});
await call("POST", "/api/assist/draft", {
  json: { messageId: "00000000-0000-0000-0000-000000000000" },
  expect: [404, 503],
  label: "POST /api/assist/draft (unknown message -> 404, or 503 with no key)",
});

step("ASK YOUR BOOKS — fail closed, and never a SQL tool");
// No key in dev: it must refuse rather than improvise. 200 is also acceptable
// if a key IS configured, because the figure firewall gates the answer.
await call("POST", "/api/assist/books", {
  json: { question: "How is my cash looking?" },
  expect: [503, 200],
  label: "POST /api/assist/books (fail-closed without a key)",
});
await call("POST", "/api/assist/books", {
  json: { question: "" },
  expect: [400],
  label: "POST /api/assist/books (empty question -> 400)",
});
await call("POST", "/api/assist/books", {
  json: { question: "x".repeat(600) },
  expect: [400],
  label: "POST /api/assist/books (over-long question -> 400)",
});

step("NOTIFICATIONS — on-my-way + cron fail-closed");
if (appt?.id) {
  await call("POST", "/api/dispatch/on-my-way", {
    json: { appointmentId: appt.id },
    expect: [200], // no transports locally -> suppressed, still a clean 200
  });
}
// No CRON_SECRET in dev: the route must refuse to exist rather than run.
await call("POST", "/api/cron/daily", {
  expect: [503],
  label: "POST /api/cron/daily (fail-closed without secret)",
});

step("MONEY REPORTS + PERIODS + TAX");
await call("GET", "/api/wip");
await call("POST", "/api/wip", { json: { asOf: new Date().toISOString().slice(0, 10) }, expect: [200, 201] });
await call("GET", "/api/dashboard/operating");
// The field board — the other dashboard, walled the other way. Asserted for
// what it must NOT contain as well as that it answers: the whole reason it is a
// separate route is that the `field` wall must never see a dollar figure, and a
// screen that strips money in the browser has already put it on the wire.
{
  const board = await call("GET", "/api/dashboard/field");
  // ⛔ ASSERT ON A REAL RESPONSE. `call` returns null when the request failed,
  // and `JSON.stringify(null ?? {})` is "{}" — which contains no money field
  // and would have reported this check as PASSING on a route that 401'd. Caught
  // on the first run it ever failed; the same shape as the exit-code gate that
  // read a flag it was not given.
  if (!board || !Array.isArray(board.tasks)) {
    failures.push("✗ /api/dashboard/field did not return a board — the money check verified nothing");
  } else if (/cents|amount|balance|profit|revenue/i.test(JSON.stringify(board))) {
    failures.push("✗ /api/dashboard/field leaked a money field into the field wall");
  } else {
    pass++;
    console.log("  ok   field board answered and carries no money field");
  }
}
await call("GET", "/api/reports/statements?from=2026-01-01&to=2026-12-31");
await call("GET", "/api/reports/forecast");
// The schedule-aware cash plan. A separate route from the forecast above, and
// deliberately so: two honest reports beat one that tries to be both.
const cashPlan = await call("GET", "/api/reports/cash-plan");
if (cashPlan) {
  if (cashPlan.weeks?.length !== 13) {
    failures.push(`CASH PLAN: expected 13 weeks, got ${cashPlan.weeks?.length}`);
  }
  // ⛔ The no-double-count invariant, checked on real data every sweep. A job
  // whose remaining contract is claimed twice inflates the plan, and an owner
  // makes hiring decisions on this number.
  if ((cashPlan.overclaimed?.length ?? 0) > 0) {
    failures.push(
      `CASH PLAN: ${cashPlan.overclaimed.length} job(s) claim more than their remaining contract`,
    );
  }
  // No percentages, anywhere. A percentage invites the reader to multiply.
  if (/%|percent|confidence/i.test(cashPlan.explain ?? "")) {
    failures.push("CASH PLAN: the explanation contains a percentage or a confidence word");
  }
  // The horizon is reported BESIDE the plan, never summed into week 13.
  const last = cashPlan.weeks?.[12];
  if (cashPlan.beyondCents !== 0 && last && last.committedCents === cashPlan.beyondCents) {
    failures.push("CASH PLAN: money past the horizon was dumped into the last week");
  }
}
await call("GET", `/api/reports/1099?year=${new Date().getFullYear()}`);
await call("GET", "/api/reports/pack?from=2026-01-01&to=2026-12-31");
await call("GET", "/api/export/journal?from=2026-01-01&to=2026-12-31");
await call("GET", "/api/periods");
await assertStepUp("POST", "/api/periods", {
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  action: "close",
});
await call("GET", "/api/tax");
await call("POST", "/api/tax", {
  json: {
    periodLabel: new Date().toISOString().slice(0, 7),
    amountCents: 12500,
    remittedOn: new Date().toISOString().slice(0, 10),
  },
  expect: [200, 201, 422],
});

step("BONDING — the surety pack reads the same books");
await call("GET", "/api/bonding");
await call("GET", "/api/bonding/package");
// The two facts a human supplies: the credit line the ledger can't see,
// and the CPA's judgement call on an account's surety class.
await call("POST", "/api/bonding/settings", {
  json: {
    action: "facility",
    lender: `Sweep Community Bank ${stamp}`,
    kind: "line-of-credit",
    limitCents: 5_000_000,
    balanceCents: 1_200_000,
  },
  label: "POST /api/bonding/settings (facility)",
});
await call("POST", "/api/bonding/settings", {
  json: { action: "classify", code: "1020", suretyClass: null },
  label: "POST /api/bonding/settings (classify)",
});
// Posting the over/under adjustment is a journal entry — step-up gated,
// and the gate is the assertion.
await assertStepUp("POST", "/api/bonding/wip-adjustment", {
  asOf: new Date().toISOString().slice(0, 10),
  revenueAccountCode: "3100",
});

step("LIGHT FENCE — a $99 tenant is refused the crew tools, and keeps the money loop");
// ⛔ Runs LAST, after every other step has used its full-plan access. Flipping
// the plan mid-sweep would starve the steps behind it.
//
// The plan is moved through the OWNER connection rather than the API because
// downgrading through Stripe needs a live subscription. What is being tested
// is the ROUTE's behaviour for a Light tenant — not how it got there.
if (process.env.MIGRATE_DATABASE_URL) {
  const admin = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
  await admin.connect();
  const t = await admin.query(
    "SELECT id FROM tenants WHERE slug LIKE 'sweep-%' ORDER BY created_at DESC LIMIT 1",
  );
  const tenantId = t.rows[0]?.id;
  if (tenantId) {
    await admin.query(
      "UPDATE subscriptions SET plan='light', seat_cap=1 WHERE tenant_id=$1",
      [tenantId],
    );

    // Fenced: every one of these must refuse with 402, not 200 and not 500.
    const FENCED = [
      ["GET", "/api/dispatch?weekStart=2026-08-10"],
      ["GET", "/api/workforce/workers"],
      ["GET", "/api/inventory/items"],
      ["GET", "/api/bonding"],
      ["GET", "/api/wip"],
      ["GET", "/api/agents/overview"],
      ["GET", "/api/approvals"],
      ["GET", "/api/comms/settings"],
      ["GET", "/api/inbox"],
    ];
    for (const [method, path] of FENCED) {
      await call(method, path, { expect: [402], label: `${method} ${path} [light: fenced]` });
    }

    // ⛔ The other half, and the half that matters more: the money loop is NOT
    // fenced. A tier that quietly took the books away would be the crippled
    // product the doctrine forbids, and it would look exactly like a pass if
    // only the refusals were checked.
    const KEPT = [
      ["GET", "/api/jobs"],
      ["GET", "/api/customers"],
      ["GET", "/api/invoices"],
      // The quoting half of the loop. (Estimates have no collection route —
      // they live under /api/jobs/[id]/estimates — and naming one here was a
      // stray call the coverage gate caught on the first run.)
      ["GET", "/api/pricebook"],
      ["GET", "/api/bank/accounts"],
      ["GET", "/api/reports/statements?from=2026-01-01&to=2026-12-31"],
      ["GET", "/api/cost-codes"],
    ];
    for (const [method, path] of KEPT) {
      await call(method, path, { expect: [200], label: `${method} ${path} [light: KEPT]` });
    }

    // /api/me must tell the shell what to hide, or the nav sends people at 402s.
    const meLight = await call("GET", "/api/me", { label: "GET /api/me [light]" });
    const missing = meLight?.missingCapabilities ?? [];
    if (missing.length !== 8) {
      failures.push(
        `light fence: /api/me reported ${missing.length} missing capabilities, expected 8 — got ${JSON.stringify(missing)}`,
      );
    } else {
      console.log(`  ok   /api/me hides all 8 fenced areas (${missing.join(", ")})`);
      pass++;
    }

    await admin.query(
      "UPDATE subscriptions SET plan='crew', seat_cap=10 WHERE tenant_id=$1",
      [tenantId],
    );
  }
  await admin.end();
} else {
  failures.push(
    "LIGHT FENCE skipped — set MIGRATE_DATABASE_URL so the sweep can move the scratch tenant onto the $99 plan",
  );
}

step("BILLING + ACCOUNT + PLATFORM");
await call("GET", "/api/billing");
await call("GET", "/api/billing/config");
await call("GET", "/api/healthz");
await call("GET", "/api/healthz/ready");
await call("GET", "/api/admin/lir", { expect: [200, 403, 404] });
await call("GET", "/api/advisor");
await assertStepUp("POST", "/api/advisor", { action: "create-invite" });

await assertStepUp("GET", "/api/account/export");

step("TEARDOWN — delete the scratch tenant");
// The in-app delete is aal2-gated (asserted, not driven). So the sweep cleans
// up through the OWNER connection instead — otherwise every run leaves a
// tenant behind and the dev database fills with debris, which is exactly the
// kind of mess that makes people stop running the suite.
await assertStepUp("POST", "/api/account/delete", { confirm: `Sweep Co ${stamp}` });

if (process.env.MIGRATE_DATABASE_URL) {
  const admin = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
  await admin.connect();
  // Use the PRODUCT'S own purge, not a hand-rolled DELETE. A plain
  // "DELETE FROM tenants" fails on the first FK without ON DELETE CASCADE
  // (agent_runs is one) — the very reason app.purge_current_tenant() walks
  // every tenant table in dependency order. Reusing it also means the sweep
  // exercises the same code the in-app delete runs.
  const scratch = await admin.query(
    "SELECT id, name FROM tenants WHERE slug LIKE 'sweep-%'",
  );
  let purged = 0;
  for (const t of scratch.rows) {
    await admin.query("SELECT set_config('app.current_tenant', $1, false)", [t.id]);
    await admin.query("SELECT app.purge_current_tenant()");
    await admin.query("DELETE FROM tenants WHERE id = $1", [t.id]);
    purged++;
  }
  await admin.query("SELECT set_config('app.current_tenant', '', false)");
  await admin.end();
  console.log(`  ok   purged ${purged} scratch tenant(s) with app.purge_current_tenant()`);
  pass++;
} else {
  failures.push(
    "TEARDOWN skipped — set MIGRATE_DATABASE_URL so the sweep can purge its own tenant",
  );
}

// ────────────────────────────────────────────────────── the coverage gate
step("COVERAGE — every route file must be exercised");
function routeFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, acc);
    else if (entry === "route.ts") acc.push(full);
  }
  return acc;
}

/**
 * Routes the sweep deliberately does NOT call, each with the reason. An
 * exemption is a decision on the record, not a silent gap.
 */
const EXEMPT = new Map([
  ["api/webhooks/stripe", "inbound from Stripe; signature-verified, covered by billing tests"],
  ["api/webhooks/stripe/billing", "inbound from Stripe; HMAC + event-id dedupe tested separately"],
  ["api/webhooks/retell", "inbound from Retell; HMAC verified, no account provisioned yet"],
  ["api/webhooks/twilio/sms", "inbound from Twilio; X-Twilio-Signature verified against the public URL, and the scheme itself is unit-tested against the documented vector"],
  ["api/inbox/media/[id]", "needs an MMS attachment copied from Twilio; the storage port has its own tests"],
  ["api/public/intake/[slug]", "unauthenticated public form; exercised by the intake step above via /api/intake"],
  ["api/public/portal/[token]", "customer portal; needs a minted portal token, covered by crm tests"],
  ["api/public/portal/[token]/checkout", "portal Stripe checkout; needs a live portal token"],
  ["api/public/portal/[token]/card", "SetupIntent flow needs Stripe network calls + a portal token; card path exercised in Stripe test mode"],
  ["api/auth/login", "Identity Platform path; dev-login covers the session mint in dev mode"],
  ["api/auth/logout", "would kill the sweep's own session mid-run"],
  ["api/demo/start", "mints the PUBLIC DEMO session over the sweep's own, killing the run mid-flight; the demo principal is covered by the viewer-readonly test and migration 0039"],
  ["api/agents/actions/[id]/decide", "needs a queued card; exercised when one exists, skipped when the run produces none"],
  ["api/billing/subscription", "changes a real Stripe subscription"],
  ["api/invoices/[id]/checkout", "creates a real Stripe Checkout session"],
  ["api/qbo/status", "reports a QBO connection; none provisioned"],
  ["api/qbo/connect", "starts an Intuit OAuth redirect"],
  ["api/qbo/callback", "Intuit redirects here with a code; needs a real OAuth round-trip"],
  ["api/qbo/disconnect", "needs a live QBO connection"],
  ["api/qbo/import", "needs a live QBO connection"],
  ["api/qbo/sync", "needs a live QBO connection"],
  ["api/attachments/[id]", "needs an uploaded object; multipart upload covered by jobs/[id]/attachments"],
  ["api/pricebook/[id]/photo", "multipart image upload; storage layer covered by its own tests"],
  ["api/jobs/[id]/attachments", "multipart upload; needs a real file fixture"],
  ["api/billing/checkout", "creates a real Stripe Checkout session"],
  ["api/billing/portal", "redirects to the Stripe billing portal"],
  ["api/agents/preferences/[id]", "needs a distilled preference from a revise decision"],
  ["api/agents/actions/[id]/undo", "needs an executed, undoable action"],
]);

const all = routeFiles(API_DIR).map((f) =>
  ["api", ...relative(API_DIR, f).split(sep).slice(0, -1)].join("/"),
);
const covered = attributeCoverage(all, touched);
const uncovered = all.filter((r) => !covered.has(r) && !EXEMPT.has(r));
const staleExempt = [...EXEMPT.keys()].filter((r) => !all.includes(r));

const stray = strayCalls(all, touched);

for (const r of uncovered) failures.push(`UNCOVERED route: ${r} — add it to the sweep or EXEMPT it with a reason`);
for (const r of staleExempt) failures.push(`STALE exemption: ${r} no longer exists — remove it`);
for (const p of stray) failures.push(`STRAY call: /${p} matches no route file — a typo in the sweep?`);

console.log(`  ${all.length} route files · ${covered.size} covered · ${EXEMPT.size} exempt · ${uncovered.length} uncovered`);

// ───────────────────────────────────────────────────────────────── verdict
console.log(`\n${"─".repeat(64)}`);
console.log(`${pass} calls passed, ${failures.length} problem(s)`);
if (failures.length) {
  console.log("");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("EVERY ENDPOINT PASSED\n");
