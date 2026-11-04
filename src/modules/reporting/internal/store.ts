import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import {
  buildBalanceSheet,
  buildCashFlow,
  buildProfitAndLoss,
  buildTrialBalance,
  type AccountBalance,
  type AccountType,
  type BalanceSheet,
  type CashFlow,
  type CashMovement,
  type ProfitAndLoss,
  type TrialBalance,
} from "./statements";

// Reporting is a READ-ONLY projection of the ledger: every query in this
// file is a SELECT. Nothing in this module may write.

export interface StatementsResult {
  from: string | null;
  to: string;
  pnl: ProfitAndLoss;
  balanceSheet: BalanceSheet;
  cashFlow: CashFlow;
  trialBalance: TrialBalance;
}

async function accountBalances(
  c: { query: (q: string, p?: unknown[]) => Promise<{ rows: unknown[] }> },
  opts: { from?: string | null; to: string; periodOnly?: boolean },
): Promise<AccountBalance[]> {
  // periodOnly (P&L, cash flow) windows by entry date; balance-sheet
  // balances are cumulative through `to`.
  const { rows } = await c.query(
    `SELECT a.code, a.name, a.type,
            COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint AS bal
       FROM chart_of_accounts a
       LEFT JOIN journal_lines l ON l.account_id = a.id
       LEFT JOIN journal_entries e ON e.id = l.entry_id
        AND e.occurred_on <= $1
        AND ($2::date IS NULL OR e.occurred_on >= $2)
      GROUP BY a.code, a.name, a.type
      HAVING COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN l.debit_cents - l.credit_cents END), 0) <> 0
      ORDER BY a.code`,
    [opts.to, opts.periodOnly ? (opts.from ?? null) : null],
  );
  return (rows as { code: string; name: string; type: AccountType; bal: string }[]).map(
    (r) => ({
      code: r.code,
      name: r.name,
      type: r.type,
      balanceCents: Number(r.bal),
    }),
  );
}

/** Cash account codes for this tenant: bank-linked GLs plus the default. */
/**
 * What counts as CASH for this tenant: every account a bank feed posts to,
 * plus the default 1020.
 *
 * Exported through the port because the forecast module needs the same answer
 * and two definitions of "cash" is how two reports start disagreeing about a
 * balance in front of an owner.
 */
/**
 * ⛔ ONLY ACCOUNTS THAT HOLD CASH. This used to union every
 * `bank_accounts.gl_account_code` regardless of kind, which was harmless
 * only while every connected account was a checking account. The moment a
 * credit card (2150) or a line of credit (2200) is added, its CREDIT balance
 * nets into "cash" on the weekly scoreboard, in the cash-flow statement and
 * as the 13-week plan's starting balance — showing an owner more money than
 * they have, by exactly the amount they owe.
 *
 * Filtering on `kind` rather than on the account code means a shop that
 * renumbers its chart stays correct.
 */
export const CASH_CODES_SQL = `
  SELECT DISTINCT code FROM (
    SELECT gl_account_code AS code FROM bank_accounts
     WHERE kind IN ('checking','savings') AND is_active
    UNION SELECT '1020'
  ) s`;

export async function getStatements(
  scope: TenantScope,
  opts: { from?: string | null; to: string },
): Promise<StatementsResult> {
  return withTenant(scope, async (c) => {
    const asOf = await accountBalances(c, { to: opts.to });
    const period = await accountBalances(c, {
      from: opts.from ?? null,
      to: opts.to,
      periodOnly: true,
    });

    // Cash flow: entries in the window that touch a cash account, bucketed
    // by the dominant counter-account. Job-WIP spend (14xx assets) is job
    // money, not customer money — tag it cogs for the bucketer.
    const cf = await c.query(
      `WITH cash AS (${CASH_CODES_SQL})
       SELECT e.id,
              SUM(CASE WHEN a.code IN (SELECT code FROM cash)
                       THEN l.debit_cents - l.credit_cents ELSE 0 END)::bigint AS cash_delta,
              (ARRAY_AGG(
                 CASE WHEN a.type = 'asset' AND a.code LIKE '14%' THEN 'cogs' ELSE a.type END
                 ORDER BY ABS(l.debit_cents - l.credit_cents) DESC
               ) FILTER (WHERE a.code NOT IN (SELECT code FROM cash)))[1] AS counter_type
         FROM journal_entries e
         JOIN journal_lines l ON l.entry_id = e.id
         JOIN chart_of_accounts a ON a.id = l.account_id
        WHERE e.occurred_on <= $1 AND ($2::date IS NULL OR e.occurred_on >= $2)
        GROUP BY e.id
       HAVING SUM(CASE WHEN a.code IN (SELECT code FROM cash)
                       THEN l.debit_cents - l.credit_cents ELSE 0 END) <> 0`,
      [opts.to, opts.from ?? null],
    );
    const movements: CashMovement[] = (
      cf.rows as { cash_delta: string; counter_type: AccountType | null }[]
    ).map((r) => ({
      cashDeltaCents: Number(r.cash_delta),
      counterType: r.counter_type ?? "asset",
    }));

    return {
      from: opts.from ?? null,
      to: opts.to,
      pnl: buildProfitAndLoss(period),
      balanceSheet: buildBalanceSheet(asOf),
      cashFlow: buildCashFlow(movements),
      trialBalance: buildTrialBalance(asOf),
    };
  });
}

// -------------------------------------------------------------- AR aging
export interface AgingBucket {
  label: string;
  amountCents: number;
}
export interface ArAging {
  buckets: AgingBucket[];
  retainageCents: number;
  totalCents: number;
  explain: string;
}

export async function getArAging(scope: TenantScope, asOf: string): Promise<ArAging> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT i.issued_on::text AS issued_on,
              (i.due_now_cents - i.paid_cents)::bigint AS open,
              i.retainage_cents::bigint AS retainage
         FROM invoices i
        WHERE i.status <> 'void'
          AND (i.due_now_cents - i.paid_cents > 0 OR i.retainage_cents > 0)`,
      [],
    );
    // ⛔ `late` TRAVELS WITH THE BUCKET. Callers used to re-derive it by
    // pattern-matching the label — the dashboard tested
    // `!/current|not due/i.test(b.label)`, which matches none of these, so
    // every bucket counted as late and the KPI reported the whole receivable
    // balance as overdue. A label is presentation; whether money is late is
    // a fact, and it belongs to the thing that decided the boundaries.
    const buckets = [
      { label: "0–30 days", amountCents: 0, late: false },
      { label: "31–60 days", amountCents: 0, late: true },
      { label: "61–90 days", amountCents: 0, late: true },
      { label: "Over 90 days", amountCents: 0, late: true },
    ];
    let retainageCents = 0;
    const asOfMs = Date.parse(asOf);
    for (const r of rows as {
      issued_on: string;
      open: string;
      retainage: string;
    }[]) {
      const open = Number(r.open);
      retainageCents += Number(r.retainage);
      if (open <= 0) continue;
      const age = Math.floor((asOfMs - Date.parse(r.issued_on)) / 86_400_000);
      const idx = age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3;
      buckets[idx]!.amountCents += open;
    }
    const openTotal = buckets.reduce((t, b) => t + b.amountCents, 0);
    const totalCents = openTotal + retainageCents;
    const d = (cents: number) =>
      `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
    const overdue = buckets[2]!.amountCents + buckets[3]!.amountCents;
    const explain =
      openTotal === 0 && retainageCents === 0
        ? "Nobody owes you money right now. All caught up."
        : overdue > 0
          ? `Customers owe you ${d(openTotal)} (plus ${d(retainageCents)} of retainage held). ${d(overdue)} of it is more than 60 days old — chase that first.`
          : `Customers owe you ${d(openTotal)}, all of it recent, plus ${d(retainageCents)} of retainage held until jobs close out.`;
    return { buckets, retainageCents, totalCents, explain };
  });
}

// ------------------------------------------------------ Weekly scoreboard
export interface ScoreboardJob {
  jobId: string;
  jobNo: number;
  name: string;
  status: string;
  costsWeekCents: number;
  invoicedWeekCents: number;
  paidWeekCents: number;
}
export interface Scoreboard {
  weekStart: string;
  cashCents: number;
  arOpenCents: number;
  jobs: ScoreboardJob[];
  explain: string;
}

export async function getScoreboard(
  scope: TenantScope,
  weekStart: string,
): Promise<Scoreboard> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT j.id, j.job_no, j.name, j.status,
              COALESCE((SELECT SUM(ce.amount_cents) FROM cost_entries ce
                         WHERE ce.job_id = j.id AND ce.occurred_on >= $1), 0)::bigint AS costs_week,
              COALESCE((SELECT SUM(i.net_subtotal_cents + i.tax_cents) FROM invoices i
                         WHERE i.job_id = j.id AND i.status <> 'draft'
                           AND i.issued_on >= $1), 0)::bigint AS invoiced_week,
              COALESCE((SELECT SUM(p.amount_cents) FROM payments p
                         JOIN invoices i ON i.id = p.invoice_id
                        WHERE i.job_id = j.id AND p.received_on >= $1), 0)::bigint AS paid_week
         FROM jobs j
        ORDER BY j.job_no`,
      [weekStart],
    );
    const cash = await c.query(
      `WITH cash AS (${CASH_CODES_SQL})
       SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint AS bal
         FROM journal_lines l
         JOIN chart_of_accounts a ON a.id = l.account_id
        WHERE a.code IN (SELECT code FROM cash)`,
    );
    const ar = await c.query(
      `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint AS bal
         FROM journal_lines l
         JOIN chart_of_accounts a ON a.id = l.account_id
        WHERE a.code IN ('1210', '1290')`,
    );
    const jobs = (rows as {
      id: string;
      job_no: number;
      name: string;
      status: string;
      costs_week: string;
      invoiced_week: string;
      paid_week: string;
    }[]).map((r) => ({
      jobId: r.id,
      jobNo: Number(r.job_no),
      name: r.name,
      status: r.status,
      costsWeekCents: Number(r.costs_week),
      invoicedWeekCents: Number(r.invoiced_week),
      paidWeekCents: Number(r.paid_week),
    }));
    const cashCents = Number((cash.rows[0] as { bal: string }).bal);
    const arOpenCents = Number((ar.rows[0] as { bal: string }).bal);
    const paid = jobs.reduce((t, j) => t + j.paidWeekCents, 0);
    const spent = jobs.reduce((t, j) => t + j.costsWeekCents, 0);
    const d = (cents: number) =>
      `$${Math.floor(Math.abs(cents) / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
    const explain = `This week you collected ${d(paid)} and spent ${d(spent)} on jobs. You have ${d(cashCents)} in the bank and customers owe you ${d(arOpenCents)}.`;
    return { weekStart, cashCents, arOpenCents, jobs, explain };
  });
}

// -------------------------------------------------- GL detail (CPA pack)
export interface GlDetailRow {
  entryId: string;
  entryDate: string;
  memo: string;
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  jobNo: number | null;
  costCode: string | null;
}

export async function getGlDetail(
  scope: TenantScope,
  opts: { from?: string | null; to: string },
): Promise<GlDetailRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT e.id AS entry_id, e.occurred_on::text AS entry_date, e.memo,
              a.code, a.name,
              l.debit_cents::bigint AS debit, l.credit_cents::bigint AS credit,
              j.job_no, l.cost_code
         FROM journal_entries e
         JOIN journal_lines l ON l.entry_id = e.id
         JOIN chart_of_accounts a ON a.id = l.account_id
         LEFT JOIN jobs j ON j.id = l.job_id
        WHERE e.occurred_on <= $1 AND ($2::date IS NULL OR e.occurred_on >= $2)
        ORDER BY e.occurred_on, e.created_at, l.line_no`,
      [opts.to, opts.from ?? null],
    );
    return (rows as {
      entry_id: string;
      entry_date: string;
      memo: string;
      code: string;
      name: string;
      debit: string;
      credit: string;
      job_no: number | null;
      cost_code: string | null;
    }[]).map((r) => ({
      entryId: r.entry_id,
      entryDate: r.entry_date,
      memo: r.memo,
      accountCode: r.code,
      accountName: r.name,
      debitCents: Number(r.debit),
      creditCents: Number(r.credit),
      jobNo: r.job_no === null ? null : Number(r.job_no),
      costCode: r.cost_code,
    }));
  });
}

// ------------------------------------------------- 13-week cash forecast
export interface ForecastWeek {
  weekStart: string;
  inCents: number;
  outCents: number;
  balanceCents: number;
}
export interface CashForecast {
  startingCashCents: number;
  weeks: ForecastWeek[];
  explain: string;
}

/**
 * Deterministic 13-week look-ahead. Inflows: open AR, expected at
 * issued_on + 30 days (already-late invoices land in week 1). Outflows:
 * open bills at due_on (or issued_on + 30). Payroll/burden accruals clear
 * when the real payroll run posts them, so they appear once paid — this is
 * a cash view, not a promise. Every figure is arithmetic over the books.
 */
export async function getCashForecast(scope: TenantScope): Promise<CashForecast> {
  return withTenant(scope, async (c) => {
    const cash = await c.query<{ bal: string }>(
      `WITH cash AS (${CASH_CODES_SQL})
       SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint AS bal
         FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
        WHERE a.code IN (SELECT code FROM cash)`,
    );
    const ar = await c.query<{ due: string; open: string }>(
      `SELECT GREATEST(issued_on + 30, CURRENT_DATE)::text AS due,
              (due_now_cents - paid_cents)::bigint AS open
         FROM invoices
        WHERE status IN ('issued', 'partial') AND due_now_cents - paid_cents > 0`,
    );
    const ap = await c.query<{ due: string; open: string }>(
      `SELECT GREATEST(COALESCE(due_on, issued_on + 30), CURRENT_DATE)::text AS due,
              (total_cents - paid_cents)::bigint AS open
         FROM bills
        WHERE status IN ('open', 'partial') AND total_cents - paid_cents > 0`,
    );

    const start = new Date();
    const day = start.getUTCDay();
    start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1)); // Monday
    const weeks: ForecastWeek[] = [];
    let balance = Number(cash.rows[0]!.bal);
    const startingCashCents = balance;
    for (let w = 0; w < 13; w++) {
      const ws = new Date(start);
      ws.setUTCDate(ws.getUTCDate() + w * 7);
      const we = new Date(ws);
      we.setUTCDate(we.getUTCDate() + 7);
      const inWeek = (d: string) => {
        const t = Date.parse(d);
        return t >= ws.getTime() && t < we.getTime();
      };
      const lastWeek = w === 12;
      const inCents = ar.rows
        .filter((r) => inWeek(r.due) || (lastWeek && Date.parse(r.due) >= we.getTime()))
        .reduce((t, r) => t + Number(r.open), 0);
      const outCents = ap.rows
        .filter((r) => inWeek(r.due) || (lastWeek && Date.parse(r.due) >= we.getTime()))
        .reduce((t, r) => t + Number(r.open), 0);
      balance += inCents - outCents;
      weeks.push({
        weekStart: ws.toISOString().slice(0, 10),
        inCents,
        outCents,
        balanceCents: balance,
      });
    }
    const d = (cents: number) =>
      `$${Math.floor(Math.abs(cents) / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
    const low = weeks.reduce((m, wk) => (wk.balanceCents < m.balanceCents ? wk : m), weeks[0]!);
    const explain =
      low.balanceCents < 0
        ? `Watch out: around the week of ${low.weekStart} you could dip to -${d(low.balanceCents)} if everyone pays on their usual schedule. Chase the oldest invoices first.`
        : `If customers pay on their usual schedule, your lowest point in the next 13 weeks is ${d(low.balanceCents)} (week of ${low.weekStart}). You stay above water the whole way.`;
    return { startingCashCents, weeks, explain };
  });
}

// -------------------------------------------------------------- owner KPIs
export interface OwnerKpis {
  revenueThisMonthCents: number;
  avgInvoiceCents: number;
  closeRateBps: number; // approved estimates / all estimates
  arDays: number; // rough DSO: open AR / (revenue90 / 90)
  explain: string;
}

export async function getOwnerKpis(scope: TenantScope): Promise<OwnerKpis> {
  return withTenant(scope, async (c) => {
    const rev = await c.query<{ mtd: string; r90: string; avg: string }>(
      // NET of member discounts throughout. "Billed this month" must be what
      // the customers were asked for, and r90 is the denominator of a DSO
      // whose numerator (open AR) is already net — mixing the two would
      // shorten every shop's days-to-get-paid by the size of its discounts.
      `SELECT COALESCE(SUM(net_subtotal_cents) FILTER (
                WHERE date_trunc('month', issued_on) = date_trunc('month', CURRENT_DATE)), 0)::bigint AS mtd,
              COALESCE(SUM(net_subtotal_cents) FILTER (
                WHERE issued_on > CURRENT_DATE - 90), 0)::bigint AS r90,
              COALESCE(AVG(net_subtotal_cents), 0)::bigint AS avg
         FROM invoices WHERE status <> 'void'`,
    );
    const est = await c.query<{ total: string; approved: string }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'approved')::int AS approved
         FROM estimates`,
    );
    const ar = await c.query<{ open: string }>(
      `SELECT COALESCE(SUM(due_now_cents - paid_cents) FILTER (
                WHERE status IN ('issued','partial')), 0)::bigint AS open
         FROM invoices`,
    );
    const mtd = Number(rev.rows[0]!.mtd);
    const r90 = Number(rev.rows[0]!.r90);
    const avgInvoice = Number(rev.rows[0]!.avg);
    const total = Number(est.rows[0]!.total);
    const approved = Number(est.rows[0]!.approved);
    const openAr = Number(ar.rows[0]!.open);
    const arDays = r90 > 0 ? Math.round(openAr / (r90 / 90)) : 0;
    const closeRateBps = total > 0 ? Math.round((approved * 10000) / total) : 0;
    const d = (cents: number) =>
      `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;
    return {
      revenueThisMonthCents: mtd,
      avgInvoiceCents: avgInvoice,
      closeRateBps,
      arDays,
      explain: `You billed ${d(mtd)} so far this month. Your average invoice is ${d(avgInvoice)}, you win ${Math.round(closeRateBps / 100)}% of the estimates you send, and money takes about ${arDays} days to come in after you bill it.`,
    };
  });
}
