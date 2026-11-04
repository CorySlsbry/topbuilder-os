import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import {
  collectionLagDays,
  computeCashPlan,
  explainCashPlan,
  mondayOf,
  overclaimedJobs,
  PLAN_WEEKS,
  type CashItem,
  type CashPlan,
  type CollectionLag,
  type JobClaim,
} from "./cash-plan";
import { formatMoney } from "@/lib/money/cents";
import { CASH_CODES_SQL } from "@/modules/reporting";

/**
 * Turn the books into cash-plan items.
 *
 * ⛔ THE ONLY PLACE CERTAINTY IS ASSIGNED, and it is assigned from STRUCTURE:
 * which table the row is in and which columns are populated. Never a score,
 * never a model, never a heuristic about "how likely this customer is to pay".
 *
 *   an issued invoice          -> contracted (it is a debt, in the books)
 *   an open bill / PO with a date -> contracted / scheduled outflow
 *   an appointment with money attached -> scheduled
 *   a recurring assumption the owner typed -> expected
 *   remaining contract with no date -> possible
 *
 * A shop can look at any row and say "yes, that's signed" or "no, that slipped".
 * They cannot do that with a confidence score, which is why there isn't one.
 */

export interface CashPlanResult extends CashPlan {
  lag: CollectionLag;
  explain: string;
  /** Rows behind the numbers, so a person can check any of them. */
  items: CashItem[];
  /**
   * Jobs whose remaining contract is claimed more than once. Should ALWAYS be
   * empty — it is surfaced rather than swallowed because a silent violation
   * inflates the plan and a visible one gets fixed.
   */
  overclaimed: { jobId: string; claimedCents: number; availableCents: number }[];
}

/** Which plan week does this date fall in? Past dates land in week 0. */
function weekOf(firstMonday: string, iso: string): number {
  const a = Date.parse(`${firstMonday}T00:00:00Z`);
  const b = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(b)) return PLAN_WEEKS; // undatable -> beyond the horizon
  const weeks = Math.floor((b - a) / (7 * 86_400_000));
  return weeks < 0 ? 0 : weeks;
}

export async function getCashPlan(scope: TenantScope): Promise<CashPlanResult> {
  return withTenant(scope, async (c) => {
    const today = new Date().toISOString().slice(0, 10);
    const firstMonday = mondayOf(today);

    // ── how long THIS shop's customers actually take ─────────────────────
    // Measured from their own paid invoices. Median with a sample floor; the
    // pure function decides, this only supplies the numbers.
    // ⛔ THE `LIMIT` MUST APPLY TO THE MOST RECENT PAYMENTS, NOT TO WHATEVER
    // 200 INVOICE UUIDs SORT FIRST. `DISTINCT ON (i.id)` forces ORDER BY to
    // lead with `i.id`, so a `LIMIT 200` in the same query samples by random
    // UUID — a fixed, arbitrary 200 invoices that barely changes as the shop
    // bills more. A shop whose customers slowed down this year would keep
    // planning cash against how fast they paid two years ago.
    //
    // So: resolve first-payment-per-invoice in the subquery (where DISTINCT
    // ON needs its ordering), then order the RESULT by recency and cut.
    const lagRows = await c.query<{ days: string }>(
      `SELECT f.days FROM (
         SELECT DISTINCT ON (i.id)
                GREATEST(0, (p.received_on - i.issued_on))::int AS days,
                p.received_on
           FROM invoices i
           JOIN payments p ON p.invoice_id = i.id
          WHERE i.issued_on IS NOT NULL
          ORDER BY i.id, p.received_on ASC
       ) f
       ORDER BY f.received_on DESC
       LIMIT 200`,
    );
    const lag = collectionLagDays(lagRows.rows.map((r) => Number(r.days)));

    const items: CashItem[] = [];

    // ── CONTRACTED IN: money already owed to us ──────────────────────────
    // due_on when a human stated one, otherwise issued_on + the measured lag.
    // The fallback is visible in the label so nobody mistakes it for a date
    // somebody agreed to.
    const ar = await c.query<{
      due: string;
      open: string;
      no: string;
      stated: boolean;
      job_id: string | null;
    }>(
      `SELECT COALESCE(due_on, issued_on + $1::int)::text AS due,
              (due_now_cents - paid_cents)::bigint        AS open,
              invoice_no::text                            AS no,
              (due_on IS NOT NULL)                        AS stated,
              job_id
         FROM invoices
        WHERE status IN ('issued','partial') AND due_now_cents - paid_cents > 0`,
      [lag.days],
    );
    for (const r of ar.rows) {
      items.push({
        week: weekOf(firstMonday, r.due),
        cents: Number(r.open),
        certainty: "contracted",
        label: r.stated
          ? `Invoice #${r.no} due ${r.due}`
          : `Invoice #${r.no} (no due date set - assuming ${lag.days} days)`,
        ...(r.job_id ? { jobId: r.job_id } : {}),
      });
    }

    // ── CONTRACTED OUT: bills we owe ─────────────────────────────────────
    const ap = await c.query<{ due: string; open: string; vendor: string }>(
      `SELECT COALESCE(b.due_on, b.issued_on + 30)::text AS due,
              (b.total_cents - b.paid_cents)::bigint     AS open,
              COALESCE(v.name, 'a vendor')               AS vendor
         FROM bills b
         LEFT JOIN vendors v ON v.id = b.vendor_id
        WHERE b.status IN ('open','partial') AND b.total_cents - b.paid_cents > 0`,
    );
    for (const r of ap.rows) {
      items.push({
        week: weekOf(firstMonday, r.due),
        cents: -Number(r.open),
        certainty: "contracted",
        label: `Bill from ${r.vendor} due ${r.due}`,
      });
    }

    // ── SCHEDULED OUT: open purchase orders with an expected date ────────
    // A PO is a promise to pay that has not become a bill yet. Undated ones
    // are deliberately LEFT OUT rather than guessed into a week — the plan
    // would rather be short a row than invent a date for it.
    const pos = await c.query<{ due: string; amt: string; vendor: string }>(
      `SELECT expected_on::text AS due, amount_cents::bigint AS amt, vendor_name AS vendor
         FROM purchase_orders
        WHERE status = 'open' AND expected_on IS NOT NULL`,
    );
    for (const r of pos.rows) {
      items.push({
        week: weekOf(firstMonday, r.due),
        cents: -Number(r.amt),
        certainty: "scheduled",
        label: `Order from ${r.vendor} expected ${r.due}`,
      });
    }

    // ── SCHEDULED IN: work on the calendar, billed at the end of its week ─
    //
    // ⛔ NO PER-APPOINTMENT REVENUE ESTIMATE. Nobody entered a number for
    // "what this Tuesday visit is worth", and inventing one is exactly the
    // fabrication this whole design refuses. What IS known is a job's
    // UNBILLED contract, so a job with work on the board contributes its
    // remaining contract ONCE, in the week of its last scheduled visit.
    const scheduled = await c.query<{
      job_id: string;
      job_no: string;
      name: string;
      last_visit: string | null;
      remaining: string;
    }>(
      `SELECT j.id AS job_id, j.job_no::text AS job_no, j.name,
              max(a.starts_at)::date::text AS last_visit,
              GREATEST(0, j.contract_cents - COALESCE(
                -- NET: remaining contract is what is still billable, and a
                -- discounted invoice consumed only what it actually billed.
                (SELECT sum(i.net_subtotal_cents) FROM invoices i
                  WHERE i.job_id = j.id AND i.status <> 'void'), 0))::bigint AS remaining
         FROM jobs j
         LEFT JOIN appointments a
           ON a.job_id = j.id AND a.starts_at >= now()
        WHERE j.status <> 'closed' AND j.contract_cents > 0
        GROUP BY j.id, j.job_no, j.name, j.contract_cents`,
    );
    const claims: JobClaim[] = [];
    for (const r of scheduled.rows) {
      const remaining = Number(r.remaining);
      if (remaining <= 0) continue;
      const dated = Boolean(r.last_visit);
      items.push({
        week: dated ? weekOf(firstMonday, r.last_visit!) : PLAN_WEEKS,
        cents: remaining,
        // On the calendar -> scheduled. No date -> backlog, which is what
        // "possible" means and why it never touches the likely balance.
        certainty: dated ? "scheduled" : "possible",
        label: dated
          ? `Job #${r.job_no} ${r.name} - bill the rest after ${r.last_visit}`
          : `Job #${r.job_no} ${r.name} - not on the calendar yet`,
        jobId: r.job_id,
      });
      // The remaining contract is claimed exactly ONCE, by this row. The
      // invariant check below is what proves that stays true if someone later
      // adds a second source of job revenue.
      claims.push({
        jobId: r.job_id,
        contractCents: remaining,
        billedCents: 0,
        underbilledCents: 0,
        scheduledCents: dated ? remaining : 0,
        backlogCents: dated ? 0 : remaining,
      });
    }

    // ── the cash it starts from ──────────────────────────────────────────
    //
    // The SAME definition of cash the financial statements use, imported
    // rather than restated. `chart_of_accounts` has no "kind" column: cash is
    // whichever accounts the bank feeds post to, plus 1020. Two definitions of
    // "cash" is how two reports start disagreeing about a balance in front of
    // an owner, and the one that is wrong is whichever they read second.
    const cash = await c.query<{ bal: string }>(
      `WITH cash AS (${CASH_CODES_SQL})
       SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint AS bal
         FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
        WHERE a.code IN (SELECT code FROM cash)`,
    );

    const plan = computeCashPlan({
      startingCashCents: Number(cash.rows[0]?.bal ?? 0),
      items,
      firstWeekStart: firstMonday,
    });

    return {
      ...plan,
      lag,
      items,
      overclaimed: overclaimedJobs(claims),
      explain: explainCashPlan(plan, lag, (cents) => `$${formatMoney(cents)}`),
    };
  });
}
