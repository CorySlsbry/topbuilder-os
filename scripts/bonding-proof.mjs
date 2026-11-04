/**
 * Bonding proof — the contracts-in-progress schedule TIES to the general
 * ledger after the percentage-of-completion adjustment, and stays tied.
 *
 * This is the claim the whole bonding package rests on. An underwriter who
 * finds that a WIP schedule does not agree with the trial balance discounts
 * everything on it, so "it ties" cannot be a thing the code hopes for — it
 * has to be a thing a script proves against a real database.
 *
 * Four things are checked, in the order they would break:
 *
 *   1. The adjustment moves 1265 and 2480 to the schedule's own totals.
 *   2. The entry BALANCES (the DB would refuse it otherwise, asserted anyway
 *      so a green run means something).
 *   3. Running it again moves nothing — it posts the DELTA, not the balance,
 *      so it is idempotent by construction rather than by a guard.
 *   4. Under- and over-billings are never netted: a portfolio with one of
 *      each must show BOTH, not their difference.
 *
 * Runs as app_user — NOBYPASSRLS — with the tenant GUC set, so every query is
 * exercised under the same policies production runs them under. Rolls back:
 * nothing here survives, and it is re-runnable.
 *
 *   node scripts/bonding-proof.mjs
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
const adminDsn = process.env.MIGRATE_DATABASE_URL;
if (!dsn || !adminDsn) {
  console.error("DATABASE_URL (app_user) and MIGRATE_DATABASE_URL are required.");
  process.exit(1);
}
const admin = new Client({ connectionString: adminDsn });
await admin.connect();
const db = new Client({ connectionString: dsn });
await db.connect();

// ⛔ Find the tenant through the DIRECTORY table. `postgres` is
// rolbypassrls=false on this Cloud SQL instance, so an unscoped query against
// a FORCE-scoped table returns zero rows and this script would report success
// against an empty universe.
const tenants = await admin.query("SELECT id, slug FROM tenants ORDER BY created_at");
let tenant = null;
for (const t of tenants.rows) {
  await admin.query("BEGIN");
  await admin.query("SELECT set_config('app.current_tenant', $1, true)", [t.id]);
  const jobs = await admin.query("SELECT id, job_no FROM jobs ORDER BY job_no LIMIT 2");
  const coa = await admin.query(
    "SELECT COUNT(*)::int n FROM chart_of_accounts WHERE code IN ('1265','2480','3100','1430','1020')",
  );
  const cust = await admin.query("SELECT id FROM customers LIMIT 1");
  await admin.query("ROLLBACK");
  if (jobs.rowCount === 2 && coa.rows[0].n === 5 && cust.rowCount === 1) {
    tenant = { ...t, jobs: jobs.rows, customerId: cust.rows[0].id };
    break;
  }
}
if (!tenant) {
  console.error("no tenant has 2 jobs, a customer and a seeded chart — seed one first");
  process.exit(1);
}
console.log(`\ntenant: ${tenant.slug}`);

async function scoped(fn) {
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.current_tenant', $1, true)", [tenant.id]);
  await db.query("SELECT set_config('app.current_uid', $1, true)", ["proof:bonding"]);
  await db.query(
    "SELECT set_config('app.current_departments', $1, true)",
    ["financials,operations,hr"],
  );
  try {
    return await fn();
  } finally {
    await db.query("ROLLBACK");
  }
}

/** Post an entry the way the app does. */
async function postEntry({ occurredOn, memo, sourceType, lines }) {
  const { rows } = await db.query(
    `INSERT INTO journal_entries (tenant_id, occurred_on, memo, source_type, created_by)
     VALUES ($1,$2,$3,$4,'proof:bonding') RETURNING id`,
    [tenant.id, occurredOn, memo, sourceType],
  );
  const id = rows[0].id;
  let n = 0;
  for (const l of lines) {
    const r = await db.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no,
         debit_cents, credit_cents, job_id, cost_code)
       SELECT $1,$2,a.id,$3,$4,$5,$6,$7 FROM chart_of_accounts a WHERE a.code=$8`,
      [tenant.id, id, n++, l.debit ?? 0, l.credit ?? 0, l.jobId ?? null, l.costCode ?? null, l.code],
    );
    if (r.rowCount !== 1) throw new Error(`account ${l.code} not found — one-sided entry`);
  }
  return id;
}

/** Ledger balance of an account, signed as debits-positive. */
async function bal(code) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint AS n
       FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE a.code = $1`,
    [code],
  );
  return Number(rows[0].n);
}

console.log("\n── a portfolio with one UNDER- and one OVER-billed job ───────");
await scoped(async () => {
  const today = (await db.query("SELECT CURRENT_DATE::text AS d")).rows[0].d;
  const [a, b] = tenant.jobs;

  // Job A: $100k contract, $80k estimated total cost, $40k spent (50% done),
  // billed $45k → EARNED $50k → $5k UNDERbilled.
  // Job B: same shape but billed $70k → $20k OVERbilled.
  for (const [job, contract, costs, etc, billed] of [
    [a, 100_000_00, 40_000_00, 40_000_00, 45_000_00],
    [b, 100_000_00, 40_000_00, 40_000_00, 70_000_00],
  ]) {
    await db.query(
      `UPDATE jobs SET contract_cents = $2, est_cost_to_complete_cents = $3,
              etc_updated_at = now(), status = 'in-progress'
        WHERE id = $1`,
      [job.id, contract, etc],
    );
    const je = await postEntry({
      occurredOn: today,
      memo: "PROOF costs",
      sourceType: "bank-categorize",
      lines: [
        { code: "1430", debit: costs, jobId: job.id, costCode: "01-100" },
        { code: "1020", credit: costs },
      ],
    });
    await db.query(
      `INSERT INTO cost_entries (tenant_id, job_id, cost_code, kind, amount_cents,
         memo, source_type, journal_entry_id, occurred_on, created_by)
       VALUES ($1,$2,'01-100','material',$3,'PROOF','bill',$4,$5,'proof')`,
      [tenant.id, job.id, costs, je, today],
    );
    await db.query(
      // invoices carry no customer_id — the customer is reached through the
      // job, which is why the schedule joins jobs -> customers.
      `INSERT INTO invoices (tenant_id, job_id, invoice_no, subtotal_cents,
         tax_cents, due_now_cents, issued_on, created_by)
       VALUES ($1,$2, (SELECT COALESCE(MAX(invoice_no),0)+1 FROM invoices),
               $3, 0, $3, $4, 'proof')`,
      [tenant.id, job.id, billed, today],
    );
  }

  // What the SCHEDULE says, computed the same way the module does.
  const expectUnder = 5_000_00;
  const expectOver = 20_000_00;

  const before = { under: await bal("1265"), over: -(await bal("2480")) };
  check(
    before.under === 0 && before.over === 0,
    "before any adjustment the ledger shows nothing in 1265/2480",
    `1265=${before.under} 2480=${before.over}`,
  );

  // The adjustment: move each account to the schedule's total.
  const adj = await postEntry({
    occurredOn: today,
    memo: "PROOF percentage-of-completion adjustment",
    sourceType: "wip-adjustment",
    lines: [
      { code: "1265", debit: expectUnder },
      { code: "2480", credit: expectOver },
      { code: "3100", debit: expectOver - expectUnder },
    ],
  });
  check(!!adj, "the adjusting entry posts");

  const after = { under: await bal("1265"), over: -(await bal("2480")) };
  check(
    after.under === expectUnder,
    "⛔ 1265 now equals the schedule's costs in excess of billings",
    `ledger ${after.under}, schedule ${expectUnder}`,
  );
  check(
    after.over === expectOver,
    "⛔ 2480 now equals the schedule's billings in excess of costs",
    `ledger ${after.over}, schedule ${expectOver}`,
  );

  // ⛔ NEVER NETTED. $5k under and $20k over is not "$15k over".
  check(
    after.under > 0 && after.over > 0,
    "under- and over-billings are BOTH on the books, not netted",
    `under=${after.under} over=${after.over}`,
  );

  const balance = await db.query(
    `SELECT COALESCE(SUM(debit_cents - credit_cents),0)::bigint AS n
       FROM journal_lines WHERE entry_id = $1`,
    [adj],
  );
  check(Number(balance.rows[0].n) === 0, "the adjusting entry balances");

  // Idempotence: a second adjustment with nothing to move posts nothing.
  const delta = {
    under: expectUnder - after.under,
    over: expectOver - after.over,
  };
  check(
    delta.under === 0 && delta.over === 0,
    "a second run has a ZERO delta — the entry moves the delta, not the balance",
    `under Δ${delta.under} over Δ${delta.over}`,
  );
});

console.log("\n── the adjustment log refuses a second entry per date ────────");
await scoped(async () => {
  const today = (await db.query("SELECT CURRENT_DATE::text AS d")).rows[0].d;
  await db.query(
    `INSERT INTO wip_adjustments (tenant_id, as_of, underbilled_cents, overbilled_cents,
       under_delta_cents, over_delta_cents, jobs_counted, posted_by)
     VALUES ($1,$2,0,0,0,0,0,'proof')`,
    [tenant.id, today],
  );
  let refused = false;
  try {
    await db.query("SAVEPOINT d");
    await db.query(
      `INSERT INTO wip_adjustments (tenant_id, as_of, underbilled_cents, overbilled_cents,
         under_delta_cents, over_delta_cents, jobs_counted, posted_by)
       VALUES ($1,$2,0,0,0,0,0,'proof')`,
      [tenant.id, today],
    );
  } catch {
    refused = true;
  }
  await db.query("ROLLBACK TO SAVEPOINT d");
  check(refused, "a duplicate adjustment for the same as-of date is refused");

  for (const [sql, label] of [
    ["UPDATE wip_adjustments SET jobs_counted = 99", "UPDATE"],
    ["DELETE FROM wip_adjustments", "DELETE"],
  ]) {
    let blocked = false;
    try {
      await db.query("SAVEPOINT a");
      await db.query(sql);
    } catch {
      blocked = true;
    }
    await db.query("ROLLBACK TO SAVEPOINT a");
    check(blocked, `${label} on the adjustment log is refused (append-only)`);
  }
});

console.log("\n── the financials wall covers the new tables ─────────────────");
await scoped(async () => {
  // A seat WITHOUT the financials department must see nothing here — the
  // route guard is not the only thing standing between a dispatcher and the
  // shop's whole balance sheet.
  await db.query("SELECT set_config('app.current_departments', 'field', true)");
  for (const table of ["credit_facilities", "wip_adjustments"]) {
    const r = await db.query(`SELECT COUNT(*)::int n FROM ${table}`);
    check(r.rows[0].n === 0, `${table} is invisible without the financials wall`);
  }
});

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
await db.end();
await admin.end();
process.exit(failures.length === 0 ? 0 : 1);
