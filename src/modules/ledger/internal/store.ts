import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { parseCsvRecords } from "@/lib/csv";
import { validateEntry, LedgerError, type EntryInput } from "./validate";

/**
 * Post a journal entry. Validation runs first (pure); the insert then runs in
 * one transaction with ALL lines in a single statement — the DB's deferred
 * balance trigger, one-sided CHECKs, immutability triggers, period-close
 * guard, and RLS are the final authority.
 */
export async function postJournalEntry(
  scope: TenantScope,
  input: EntryInput,
): Promise<string> {
  return withTenant(scope, (c) => postJournalEntryTx(c, scope, input));
}

/**
 * Same-transaction variant: post using an ALREADY-SCOPED client so callers
 * (e.g. field-ops cost capture) can write their operational row and its GL
 * posting atomically — both commit or neither does.
 */
export async function postJournalEntryTx(
  c: PoolClient,
  scope: TenantScope,
  input: EntryInput,
): Promise<string> {
  validateEntry(input);
  {
    const accountIds = await resolveAccountIds(
      c,
      scope.tenantId,
      input.lines.map((l) => l.accountCode),
    );

    let rows: { id: string }[];
    try {
      ({ rows } = await c.query<{ id: string }>(
        `INSERT INTO journal_entries
         (tenant_id, occurred_on, memo, source_type, source_id, reversal_of, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        scope.tenantId,
        input.occurredOn,
        input.memo ?? "",
        input.sourceType ?? "manual",
        input.sourceId ?? null,
        input.reversalOf ?? null,
        scope.uid,
      ],
      ));
    } catch (err) {
      // The DB trigger refuses postings into a CLOSED fiscal period — map
      // it to a clean client error instead of a 500.
      if (err instanceof Error && err.message.includes("is closed")) {
        throw new LedgerError("period_closed");
      }
      throw err;
    }
    const entryId = rows[0]!.id;

    // One multi-row INSERT so the deferred balance trigger sees the complete
    // entry no matter when it fires.
    const cols = 11;
    const values: unknown[] = [];
    const tuples = input.lines.map((line, i) => {
      const base = i * cols;
      values.push(
        scope.tenantId,
        entryId,
        accountIds.get(line.accountCode),
        i + 1,
        line.debitCents ?? 0,
        line.creditCents ?? 0,
        line.jobId ?? null,
        line.costCode ?? null,
        line.class ?? null,
        line.customerId ?? null,
        line.vendorId ?? null,
      );
      const ph = Array.from({ length: cols }, (_, j) => `$${base + j + 1}`);
      return `(${ph.join(",")})`;
    });
    await c.query(
      `INSERT INTO journal_lines
         (tenant_id, entry_id, account_id, line_no, debit_cents, credit_cents,
          job_id, cost_code, class, customer_id, vendor_id)
       VALUES ${tuples.join(",")}`,
      values,
    );
    return entryId;
  }
}

async function resolveAccountIds(
  c: PoolClient,
  tenantId: string,
  codes: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(codes)];
  const { rows } = await c.query<{ id: string; code: string }>(
    `SELECT id, code FROM chart_of_accounts
      WHERE tenant_id = $1 AND code = ANY($2) AND is_active`,
    [tenantId, unique],
  );
  const map = new Map(rows.map((r) => [r.code, r.id]));
  for (const code of unique) {
    if (!map.has(code)) throw new LedgerError(`unknown_account:${code}`);
  }
  return map;
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  debitCents: number;
  creditCents: number;
}

/** Trial balance as of a date (inclusive). Σdebits always equals Σcredits. */
export async function getTrialBalance(
  scope: TenantScope,
  asOf?: string,
): Promise<TrialBalanceRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<TrialBalanceRow>(
      `SELECT a.code, a.name, a.type,
              COALESCE(SUM(l.debit_cents), 0)::bigint  AS "debitCents",
              COALESCE(SUM(l.credit_cents), 0)::bigint AS "creditCents"
         FROM chart_of_accounts a
         JOIN journal_lines l ON l.account_id = a.id
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE ($1::date IS NULL OR e.occurred_on <= $1::date)
        GROUP BY a.code, a.name, a.type
        ORDER BY a.code`,
      [asOf ?? null],
    );
    // pg returns bigint as string; normalize to integer cents.
    return rows.map((r) => ({
      ...r,
      debitCents: Number(r.debitCents),
      creditCents: Number(r.creditCents),
    }));
  });
}

// ---------------------------------------------------------------- NAHB seed
const TAG_TO_TYPE: Record<string, string> = {
  asset: "asset",
  "fixed-asset": "asset",
  "contra-asset": "asset",
  "wip-control": "asset",
  liability: "liability",
  equity: "equity",
  "contra-equity": "equity",
  revenue: "revenue",
  "other-income": "revenue",
  "contra-revenue": "revenue",
  cogs: "cogs",
  "contra-wip": "cogs",
  indirect: "expense",
  "contra-indirect": "expense",
  ga: "expense",
  "ga-nondeductible": "expense",
  "sales-marketing": "expense",
  rental: "expense",
  financing: "expense",
  "tax-provision": "expense",
  "other-expense": "expense",
};

/**
 * Seed the tenant's chart of accounts from the NAHB fixture (477 rows, 412
 * postable accounts; `header` rows are section labels, not accounts).
 * Idempotent: ON CONFLICT (tenant_id, code) DO NOTHING.
 */
export async function seedNahbChart(scope: TenantScope): Promise<number> {
  const csv = readFileSync(
    join(process.cwd(), "db", "seed", "nahb-coa.csv"),
    "utf8",
  );
  const records = parseCsvRecords(csv).filter(
    (r) => r["Tag"] !== "header" && r["Account"],
  );
  return withTenant(scope, async (c) => {
    let inserted = 0;
    for (const r of records) {
      const res = await c.query(
        `INSERT INTO chart_of_accounts
           (tenant_id, code, name, type, section, description, tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, code) DO NOTHING`,
        [
          scope.tenantId,
          r["Account"],
          r["Name"],
          TAG_TO_TYPE[r["Tag"] ?? ""] ?? "other",
          r["Section"],
          r["Description"],
          r["Tag"],
        ],
      );
      inserted += res.rowCount ?? 0;
    }
    // Platform accounts BEYOND the NAHB fixture. The endpoint sweep caught
    // the gap this closes: migration 0037 added 3138 to tenants that existed
    // when it ran, but a tenant created AFTERWARDS seeds from the CSV alone —
    // so the first membership visit it completed threw unknown_account:3138.
    // Anything the PLATFORM posts to belongs in this list, not only in a
    // one-time migration loop.
    for (const extra of PLATFORM_ACCOUNTS) {
      const res = await c.query(
        `INSERT INTO chart_of_accounts
           (tenant_id, code, name, type, section, description)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, code) DO NOTHING`,
        [scope.tenantId, extra.code, extra.name, extra.type, extra.section, extra.description],
      );
      inserted += res.rowCount ?? 0;
    }
    return inserted;
  });
}

/**
 * Accounts the platform itself posts to, present in EVERY tenant regardless
 * of fixture vintage. Keep this list in lockstep with the posting code:
 * a code referenced by a posting rule but absent here is a time bomb that
 * only explodes for tenants created after its migration.
 */
const PLATFORM_ACCOUNTS = [
  {
    code: "3138",
    name: "Service agreement revenue",
    type: "revenue",
    section: "3000-3990 Sales, Revenues, Cost of Sales",
    description:
      "Membership / maintenance agreement revenue, earned per completed " +
      "visit (annual prepay) or monthly (monthly plans).",
  },
] as const;

// ------------------------------------------------------------ period close
/** Close a month: the DB trigger then refuses any posting dated inside it.
 *  Corrections afterward are reversing entries in an OPEN period — the
 *  closed month never changes. */
export async function closePeriod(
  scope: TenantScope,
  periodStart: string, // first of month, yyyy-mm-01
): Promise<void> {
  await withTenant(scope, async (c) => {
    await c.query(
      `INSERT INTO fiscal_periods (tenant_id, period_start, status, closed_at, closed_by)
       VALUES ($1, $2, 'closed', now(), $3)
       ON CONFLICT (tenant_id, period_start) DO UPDATE SET
         status = 'closed', closed_at = now(), closed_by = EXCLUDED.closed_by`,
      [scope.tenantId, periodStart, scope.uid],
    );
  });
}

export async function listPeriods(
  scope: TenantScope,
): Promise<{ periodStart: string; status: string }[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT period_start::text AS "periodStart", status
         FROM fiscal_periods ORDER BY period_start DESC LIMIT 24`,
    );
    return rows as { periodStart: string; status: string }[];
  });
}

/** The lines of one posted entry — what a reversal flips. Same-client so a
 *  void reads and reverses inside ONE transaction.
 *
 *  ⛔ THE DIMENSIONS COME BACK TOO, AND THEY ARE NOT DECORATION.
 *  `journal_lines` carries job / cost-code / class / customer / vendor, and
 *  the P&L-by-job report reads them (`reporting` joins `jobs ON j.id =
 *  l.job_id`). A reversal that dropped them would balance perfectly at the
 *  company level and leave the original cost sitting on that job's profit
 *  report with no offset — the report would be wrong in exactly the place a
 *  correction was made to fix. Reverse the line, reverse the whole line. */
export async function getEntryLinesTx(
  c: import("pg").PoolClient,
  journalEntryId: string,
): Promise<
  {
    accountCode: string;
    debitCents: number;
    creditCents: number;
    jobId?: string;
    costCode?: string;
    class?: string;
    customerId?: string;
    vendorId?: string;
  }[]
> {
  const { rows } = await c.query<{
    code: string;
    debit_cents: string;
    credit_cents: string;
    job_id: string | null;
    cost_code: string | null;
    class: string | null;
    customer_id: string | null;
    vendor_id: string | null;
  }>(
    `SELECT a.code, l.debit_cents, l.credit_cents,
            l.job_id, l.cost_code, l.class, l.customer_id, l.vendor_id
       FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE l.entry_id = $1 ORDER BY l.line_no`,
    [journalEntryId],
  );
  return rows.map((r) => ({
    accountCode: r.code,
    debitCents: Number(r.debit_cents),
    creditCents: Number(r.credit_cents),
    // undefined rather than null: EntryLineInput's fields are optional, and a
    // null would have to be stripped at every call site instead of here.
    jobId: r.job_id ?? undefined,
    costCode: r.cost_code ?? undefined,
    class: r.class ?? undefined,
    customerId: r.customer_id ?? undefined,
    vendorId: r.vendor_id ?? undefined,
  }));
}
