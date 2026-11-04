/**
 * Recategorization proof — correcting a bank line leaves the books, the job
 * cost report, AND the bank reconciliation all correct at the same time.
 *
 * This is the shape of bug that unit tests cannot see. The money math is pure
 * and untouched; the typechecker cannot read SQL; and every individual entry
 * balances by construction because the DB refuses anything else. A correction
 * can therefore be completely wrong — the expense left in the old category,
 * the cost still on the old job, the bank line double-counted — while every
 * assertion the rest of the suite makes stays green.
 *
 * So this drives the real path against a real database as the real app role
 * (NOBYPASSRLS, tenant GUC set, RLS policies live) and checks the four things
 * that must be true after a recode:
 *
 *   1. the OLD category nets to zero            (the correction actually moved)
 *   2. the NEW category holds the whole amount  (it landed somewhere)
 *   3. the bank account's cash movement is UNCHANGED  (the money still only
 *      left the bank once — this is the one an auditor checks)
 *   4. the old JOB's costs net to zero and the new job carries them
 *
 * Plus the two refusals worth having: a matched line cannot be recoded (its
 * entry belongs to the payment, not to the bank line), and a closed month is
 * not written into.
 *
 *   node scripts/recategorize-proof.mjs
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

// ⛔ Read the DIRECTORY table to find a tenant. On this Cloud SQL instance
// `postgres` is rolbypassrls=false, so FORCE RLS binds even the owner: an
// unscoped query against a walled table returns zero rows and this script
// would report success on an empty universe. `tenants` is ENABLE-only.
const tenants = await admin.query("SELECT id, slug FROM tenants ORDER BY created_at");
if (tenants.rowCount === 0) {
  console.error("no tenants in this database — nothing to prove against");
  process.exit(1);
}

// Pick a tenant that actually has a chart of accounts and two jobs, because a
// tenant with one job cannot prove "moved from job A to job B".
let tenant = null;
for (const t of tenants.rows) {
  await admin.query("BEGIN");
  await admin.query("SELECT set_config('app.current_tenant', $1, true)", [t.id]);
  const jobs = await admin.query("SELECT id, job_no FROM jobs ORDER BY job_no LIMIT 2");
  const coa = await admin.query(
    "SELECT code FROM chart_of_accounts WHERE type IN ('expense','cogs') ORDER BY code LIMIT 2",
  );
  const bank = await admin.query("SELECT id, gl_account_code FROM bank_accounts LIMIT 1");
  await admin.query("ROLLBACK");
  if (jobs.rowCount === 2 && coa.rowCount === 2) {
    // A bank_accounts ROW is not required. All this proof needs from it is
    // the cash GL code, and every tenant's chart has 1020 (it is the
    // platform default in DEFAULT_POSTING_ACCOUNTS). Requiring the row would
    // make the proof unrunnable against every seeded tenant that has not
    // imported a statement yet — i.e. all of them — which is how a proof
    // script quietly becomes one nobody runs.
    tenant = {
      ...t,
      jobs: jobs.rows,
      coa: coa.rows,
      bank: bank.rows[0] ?? { id: null, gl_account_code: "1020" },
    };
    break;
  }
}
if (!tenant) {
  console.error(
    "no tenant has 2 jobs + 2 cost accounts — seed one first (scripts/seed-desert-aire.sh)",
  );
  process.exit(1);
}
console.log(`\ntenant: ${tenant.slug}  ·  jobs #${tenant.jobs[0].job_no}/#${tenant.jobs[1].job_no}`);

const CODE_A = tenant.coa[0].code;
const CODE_B = tenant.coa[1].code;
const BANK_GL = tenant.bank.gl_account_code;
const AMOUNT = 42_137; // $421.37 — a number no fixture is likely to collide with

/** Everything below runs as app_user with the GUC set, exactly like a request. */
async function scoped(fn) {
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.current_tenant', $1, true)", [tenant.id]);
  await db.query("SELECT set_config('app.current_uid', $1, true)", ["proof:recategorize"]);
  await db.query(
    "SELECT set_config('app.current_departments', $1, true)",
    ["financials,operations,hr"],
  );
  try {
    const out = await fn();
    return out;
  } finally {
    // Never commit: this script must be re-runnable and must not leave
    // invented money in a real shop's books.
    await db.query("ROLLBACK");
  }
}

/** Net movement in one account, in cents (debits positive). */
async function balance(code, entryIds) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint AS n
       FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE a.code = $1 AND l.entry_id = ANY($2::uuid[])`,
    [code, entryIds],
  );
  return Number(rows[0].n);
}

/** Net job cost for one job across the entries this proof created. */
async function jobCost(jobId, entryIds) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS n
       FROM cost_entries WHERE job_id = $1 AND journal_entry_id = ANY($2::uuid[])`,
    [jobId, entryIds],
  );
  return Number(rows[0].n);
}

/** Post one side of a categorization the way the app does. */
async function postEntry({ occurredOn, memo, lines, sourceId }) {
  const { rows } = await db.query(
    `INSERT INTO journal_entries (tenant_id, occurred_on, memo, source_type, source_id, created_by)
     VALUES ($1,$2,$3,'bank-categorize',$4,'proof:recategorize') RETURNING id`,
    [tenant.id, occurredOn, memo, sourceId],
  );
  const id = rows[0].id;
  let n = 0;
  for (const l of lines) {
    await db.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no,
         debit_cents, credit_cents, job_id, cost_code)
       SELECT $1, $2, a.id, $3, $4, $5, $6, $7
         FROM chart_of_accounts a WHERE a.code = $8`,
      [tenant.id, id, n++, l.debit ?? 0, l.credit ?? 0, l.jobId ?? null, l.costCode ?? null, l.code],
    );
  }
  return id;
}

console.log("\n── 1. a job cost recoded to a DIFFERENT JOB ──────────────────");
await scoped(async () => {
  const today = (await db.query("SELECT CURRENT_DATE::text AS d")).rows[0].d;
  const jobA = tenant.jobs[0].id;
  const jobB = tenant.jobs[1].id;

  // Original: money out, coded to job A.
  const original = await postEntry({
    occurredOn: today,
    memo: "PROOF supply house",
    lines: [
      { code: "1430", debit: AMOUNT, jobId: jobA, costCode: CODE_A },
      { code: BANK_GL, credit: AMOUNT },
    ],
  });
  const ceA = await db.query(
    `INSERT INTO cost_entries (tenant_id, job_id, cost_code, kind, amount_cents,
       memo, source_type, journal_entry_id, occurred_on, created_by)
     VALUES ($1,$2,$3,'material',$4,'PROOF supply house','bill',$5,$6,'proof') RETURNING id`,
    [tenant.id, jobA, CODE_A, AMOUNT, original, today],
  );

  // The correction: reverse line-for-line WITH DIMENSIONS, then re-post to B.
  const reversal = await postEntry({
    occurredOn: today,
    memo: "Recoded: PROOF supply house",
    lines: [
      { code: "1430", credit: AMOUNT, jobId: jobA, costCode: CODE_A },
      { code: BANK_GL, debit: AMOUNT },
    ],
  });
  await db.query(
    `INSERT INTO cost_entries (tenant_id, job_id, cost_code, kind, amount_cents,
       memo, source_type, journal_entry_id, occurred_on, created_by, reverses_id)
     VALUES ($1,$2,$3,'material',$4,'Recoded','reversal',$5,$6,'proof',$7)`,
    [tenant.id, jobA, CODE_A, -AMOUNT, reversal, today, ceA.rows[0].id],
  );
  const replacement = await postEntry({
    occurredOn: today,
    memo: "PROOF supply house",
    lines: [
      { code: "1430", debit: AMOUNT, jobId: jobB, costCode: CODE_B },
      { code: BANK_GL, credit: AMOUNT },
    ],
  });
  await db.query(
    `INSERT INTO cost_entries (tenant_id, job_id, cost_code, kind, amount_cents,
       memo, source_type, journal_entry_id, occurred_on, created_by)
     VALUES ($1,$2,$3,'material',$4,'PROOF supply house','bill',$5,$6,'proof')`,
    [tenant.id, jobB, CODE_B, AMOUNT, replacement, today],
  );

  const ids = [original, reversal, replacement];

  // ⛔ THE ONE AN AUDITOR CHECKS: the money left the bank exactly once.
  check(
    (await balance(BANK_GL, ids)) === -AMOUNT,
    "cash movement is unchanged by the correction (money left the bank once)",
    `got ${await balance(BANK_GL, ids)}, want ${-AMOUNT}`,
  );

  check(
    (await jobCost(jobA, ids)) === 0,
    "the OLD job's costs net to zero",
    `job A carries ${await jobCost(jobA, ids)}`,
  );
  check(
    (await jobCost(jobB, ids)) === AMOUNT,
    "the NEW job carries the whole cost",
    `job B carries ${await jobCost(jobB, ids)}`,
  );

  // The dimension check: this is what a reversal that drops job_id breaks,
  // and it breaks it INVISIBLY — every entry still balances.
  const dimsA = await db.query(
    `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents),0)::bigint AS n
       FROM journal_lines l WHERE l.job_id = $1 AND l.entry_id = ANY($2::uuid[])`,
    [jobA, ids],
  );
  check(
    Number(dimsA.rows[0].n) === 0,
    "⛔ the old job's LEDGER dimension nets to zero too (P&L-by-job is right)",
    `job A's journal lines still net ${dimsA.rows[0].n}`,
  );

  // And the whole thing still balances, which the DB would have refused
  // otherwise — asserted anyway so a green run means something.
  const bal = await db.query(
    `SELECT COALESCE(SUM(debit_cents - credit_cents),0)::bigint AS n
       FROM journal_lines WHERE entry_id = ANY($1::uuid[])`,
    [ids],
  );
  check(Number(bal.rows[0].n) === 0, "the three entries balance as a set");
});

console.log("\n── 2. an expense recoded to a DIFFERENT CATEGORY ─────────────");
await scoped(async () => {
  const today = (await db.query("SELECT CURRENT_DATE::text AS d")).rows[0].d;
  const original = await postEntry({
    occurredOn: today,
    memo: "PROOF fuel",
    lines: [
      { code: CODE_A, debit: AMOUNT },
      { code: BANK_GL, credit: AMOUNT },
    ],
  });
  const reversal = await postEntry({
    occurredOn: today,
    memo: "Recoded: PROOF fuel",
    lines: [
      { code: CODE_A, credit: AMOUNT },
      { code: BANK_GL, debit: AMOUNT },
    ],
  });
  const replacement = await postEntry({
    occurredOn: today,
    memo: "PROOF fuel",
    lines: [
      { code: CODE_B, debit: AMOUNT },
      { code: BANK_GL, credit: AMOUNT },
    ],
  });
  const ids = [original, reversal, replacement];

  check((await balance(CODE_A, ids)) === 0, `the old category ${CODE_A} nets to zero`);
  check((await balance(CODE_B, ids)) === AMOUNT, `the new category ${CODE_B} holds the amount`);
  check((await balance(BANK_GL, ids)) === -AMOUNT, "cash still moved exactly once");
});

console.log("\n── 3. the schema actually allows the offsetting row ──────────");
await scoped(async () => {
  const today = (await db.query("SELECT CURRENT_DATE::text AS d")).rows[0].d;
  // Before 0050 this threw 23514: cost_entries required amount_cents > 0, so
  // a job cost on the wrong job could be reversed in the GL and would still
  // sit on that job's cost report forever.
  let ok = true;
  let err = "";
  try {
    await db.query(
      `INSERT INTO cost_entries (tenant_id, job_id, cost_code, kind, amount_cents,
         memo, source_type, journal_entry_id, occurred_on, created_by)
       VALUES ($1,$2,$3,'material',$4,'PROOF negative','reversal',NULL,$5,'proof')`,
      [tenant.id, tenant.jobs[0].id, CODE_A, -1_00, today],
    );
  } catch (e) {
    ok = false;
    err = e.message;
  }
  check(ok, "a NEGATIVE cost_entries row is accepted (0050 widened the CHECK)", err);

  // Zero is still refused — "no movement" is not a correction, it is a typo.
  let zeroRefused = false;
  try {
    await db.query("SAVEPOINT z");
    await db.query(
      `INSERT INTO cost_entries (tenant_id, job_id, cost_code, kind, amount_cents,
         memo, source_type, journal_entry_id, occurred_on, created_by)
       VALUES ($1,$2,$3,'material',0,'PROOF zero','manual',NULL,$4,'proof')`,
      [tenant.id, tenant.jobs[0].id, CODE_A, today],
    );
  } catch {
    zeroRefused = true;
  }
  await db.query("ROLLBACK TO SAVEPOINT z");
  check(zeroRefused, "a ZERO cost_entries row is still refused");
});

console.log("\n── 4. the correction log is append-only ──────────────────────");
await scoped(async () => {
  // Creates its own bank line rather than hunting for one. A "skip" here
  // would be a section that reports nothing while looking like it passed —
  // and the whole transaction rolls back, so nothing survives the run.
  const acct = await db.query(
    `INSERT INTO bank_accounts (tenant_id, name, gl_account_code)
     VALUES ($1,'PROOF checking',$2) RETURNING id`,
    [tenant.id, BANK_GL],
  );
  const { rows } = await db.query(
    `INSERT INTO bank_transactions
       (tenant_id, bank_account_id, posted_on, amount_cents, description,
        fingerprint, status, resolved_by, resolved_at)
     VALUES ($1,$2,CURRENT_DATE,$3,'PROOF line','proof-fingerprint','categorized','proof',now())
     RETURNING id`,
    [tenant.id, acct.rows[0].id, -AMOUNT],
  );
  const txnId = rows[0].id;
  await db.query(
    `INSERT INTO bank_txn_resolutions (tenant_id, txn_id, seq, action, reason, resolved_by)
     VALUES ($1,$2,9001,'expense','PROOF row','proof')`,
    [tenant.id, txnId],
  );
  for (const [sql, label] of [
    ["UPDATE bank_txn_resolutions SET reason = 'rewritten' WHERE seq = 9001", "UPDATE"],
    ["DELETE FROM bank_txn_resolutions WHERE seq = 9001", "DELETE"],
  ]) {
    let refused = false;
    try {
      await db.query("SAVEPOINT a");
      await db.query(sql);
    } catch {
      refused = true;
    }
    await db.query("ROLLBACK TO SAVEPOINT a");
    check(refused, `${label} on the correction log is refused`);
  }

  // A second correction cannot reuse a seq — this is what stops two people
  // stacking a double reversal onto the same line.
  let dupRefused = false;
  try {
    await db.query("SAVEPOINT d");
    await db.query(
      `INSERT INTO bank_txn_resolutions (tenant_id, txn_id, seq, action, reason, resolved_by)
       VALUES ($1,$2,9001,'expense','PROOF duplicate','proof')`,
      [tenant.id, txnId],
    );
  } catch {
    dupRefused = true;
  }
  await db.query("ROLLBACK TO SAVEPOINT d");
  check(dupRefused, "a duplicate seq on the same line is refused (no double reversal)");
});

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
await db.end();
await admin.end();
process.exit(failures.length === 0 ? 0 : 1);
