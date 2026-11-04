import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { withTenant } from "@/lib/db/tenant";
import { getArAging, getOwnerKpis, getScoreboard } from "@/modules/reporting";
import { buildDecisions, nothingToDecide } from "@/modules/reporting";
import { getCipSchedule } from "@/modules/job-costing";
import { getCashPlan } from "@/modules/forecast";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/**
 * The operating dashboard — the owner's Monday-morning view.
 *
 * Composed at the ROUTE layer rather than inside a module, the same way job
 * profit is: this reads across job-costing, reporting and forecast, and an
 * import between any two of them would be a module cycle waiting to happen.
 *
 * Financials wall, obviously — this is the whole business on one screen.
 */
export const GET = route(async () => {
  const scope = await requireScope({ departments: ["financials"] });
  const today = new Date().toISOString().slice(0, 10);
  // Monday of the current week — the scoreboard is a WEEKLY figure and
  // handing it today's date would silently report a partial week.
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const weekStart = d.toISOString().slice(0, 10);

  const [cip, aging, kpis, scoreboard, cashPlan, extras] = await Promise.all([
    getCipSchedule(scope),
    getArAging(scope, today),
    getOwnerKpis(scope),
    getScoreboard(scope, weekStart),
    getCashPlan(scope).catch(() => null),
    loadExtras(scope),
  ]);

  // ── the decision list, from facts the deterministic layer computed ─────
  const facts = {
    // Only jobs with something material to bill. A $12 under-billing is
    // arithmetic, not a decision, and a list that reports it teaches people
    // to skim the list.
    underbilled: cip.rows
      .filter((r) => r.underbilledCents >= 50_000)
      .map((r) => ({ jobId: r.jobId, jobNo: r.jobNo, name: r.name, cents: r.underbilledCents })),
    lateInvoices: extras.lateInvoices,
    lateBills: extras.lateBills,
    overdueRetainage: extras.overdueRetainage,
    // ⛔ The cash plan is the ONLY thing that knows this, and it is composed
    // here — so it has to be joined here. `loadExtras` cannot see it, which
    // is why this used to be a hardcoded `null` that made the whole
    // "cash runs out" decision branch dead code no matter what the plan said.
    cashLow: cashPlan
      ? {
          weekLabel: `the week of ${cashPlan.low.committed.weekStart}`,
          cents: cashPlan.low.committed.balanceCents,
          // Zero, not a setting: nobody has been asked for a reserve floor,
          // so the only threshold this product can honestly assert is
          // running out of money. If a cash-floor setting is ever added,
          // this is the one line that reads it.
          floorCents: 0,
        }
      : null,
    lossJobs: cip.rows
      .filter((r) => r.flags.lossJob)
      .map((r) => ({
        jobId: r.jobId,
        jobNo: r.jobNo,
        name: r.name,
        cents: Math.abs(r.estGrossProfitCents),
      })),
    staleEtc: cip.rows
      .filter((r) => r.flags.staleEtc)
      // The REAL age. `days: 30` was the threshold, printed as if it were the
      // measurement — an estimate untouched for eight months reported "30
      // days old", which is the one number that would have made the owner
      // act. The flag can only be true when etcAgeDays is set and over 30
      // (see wip.ts), so the fallback is unreachable and stays honest.
      .map((r) => ({
        jobId: r.jobId,
        jobNo: r.jobNo,
        name: r.name,
        days: r.etcAgeDays ?? 31,
      })),
    unansweredBankLines: extras.unansweredBankLines,
    completedNotInvoiced: extras.completedNotInvoiced,
  };

  return NextResponse.json({
    asOf: cip.asOf,
    decisions: buildDecisions(facts),
    nothingToDo: nothingToDecide(facts),
    cip: {
      rows: cip.rows,
      totals: cip.totals,
      explain: cip.explain,
      tied: cip.tieOut.tied,
    },
    aging,
    kpis,
    scoreboard,
    cashPlan,
    ...extras,
  });
});

/**
 * The handful of figures no existing report already produces. Kept in one
 * function so the count of extra queries this screen costs is visible in one
 * place rather than scattered through the composition above.
 */
async function loadExtras(scope: Parameters<typeof getArAging>[0]) {
  return withTenant(scope, async (c) => {
    const [late, bills, bank, completed, cash, retainage] = await Promise.all([
      c.query<{
        id: string; invoice_no: string; customer_name: string;
        open_cents: string; days_late: string;
      }>(
        `SELECT i.id, i.invoice_no, cu.name AS customer_name,
                (i.due_now_cents - i.paid_cents) AS open_cents,
                (CURRENT_DATE - i.issued_on)::text AS days_late
           FROM invoices i
           JOIN jobs j ON j.id = i.job_id
           JOIN customers cu ON cu.id = j.customer_id
          WHERE i.status IN ('issued','partial')
            AND i.due_now_cents > i.paid_cents
            -- Net 30 is the product's working assumption until invoices
            -- carry a due date of their own; stated here rather than hidden.
            AND i.issued_on < CURRENT_DATE - 30
          ORDER BY i.issued_on
          LIMIT 20`,
      ),
      c.query<{ id: string; vendor_name: string; open_cents: string; days_late: string }>(
        `SELECT b.id, v.name AS vendor_name,
                (b.total_cents - COALESCE(p.paid, 0)) AS open_cents,
                (CURRENT_DATE - COALESCE(b.due_on, b.issued_on + 30))::text AS days_late
           FROM bills b
           JOIN vendors v ON v.id = b.vendor_id
           LEFT JOIN (
             SELECT bill_id, SUM(amount_cents) AS paid FROM bill_payments GROUP BY bill_id
           ) p ON p.bill_id = b.id
          -- ⛔ VOIDS EXCLUDED. A voided bill keeps its total_cents and has
          -- no payments against it, so without this it is permanently
          -- "overdue" — and the decision list tells the owner a sub they
          -- never owed can put a lien on the job.
          WHERE b.status IN ('open','partial')
            AND b.total_cents > COALESCE(p.paid, 0)
            AND COALESCE(b.due_on, b.issued_on + 30) < CURRENT_DATE
          ORDER BY COALESCE(b.due_on, b.issued_on + 30)
          LIMIT 20`,
      ),
      c.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM bank_transactions WHERE status = 'pending'",
      ),
      c.query<{ id: string; job_no: string; name: string }>(
        `SELECT j.id, j.job_no, j.name
           FROM jobs j
          WHERE j.status IN ('complete','closed')
            AND NOT EXISTS (
              SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status <> 'void'
            )
          ORDER BY j.completed_on DESC NULLS LAST
          LIMIT 10`,
      ),
      // Cash on hand, from the accounts that actually hold cash.
      c.query<{ n: string }>(
        `WITH cash AS (
           SELECT DISTINCT code FROM (
             SELECT gl_account_code AS code FROM bank_accounts
              WHERE kind IN ('checking','savings') AND is_active
             UNION SELECT '1020'
           ) s
         )
         SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::text AS n
           FROM journal_lines l
           JOIN chart_of_accounts a ON a.id = l.account_id
          WHERE a.code IN (SELECT code FROM cash)`,
      ),
      /**
       * Retainage still held on FINISHED work.
       *
       * ⛔ This used to be a hardcoded `[]`, which made the whole retainage
       * branch of the decision list unreachable — the code existed, the copy
       * existed, and it could never fire.
       *
       * There is no retainage-release record in the schema, so "overdue" is
       * derived from what IS recorded: `due_now_cents` is the invoice total
       * MINUS retainage (0006), so anything paid beyond due_now is retainage
       * the customer has since released. What is left on a job that is
       * already complete is money being held against work that is done —
       * which is exactly the trade meaning of retainage coming due.
       */
      c.query<{
        id: string; job_no: string; name: string;
        cents: string; days_overdue: string;
      }>(
        `SELECT j.id, j.job_no, j.name,
                SUM(i.retainage_cents - LEAST(i.retainage_cents,
                      GREATEST(0, i.paid_cents - i.due_now_cents)))::text AS cents,
                (CURRENT_DATE - j.completed_on)::text AS days_overdue
           FROM jobs j
           JOIN invoices i ON i.job_id = j.id AND i.status <> 'void'
          -- completed_on NOT NULL is load-bearing: "held for N days" needs a
          -- day to count from, and a job marked complete without one cannot
          -- support the claim. There is no updated_at on jobs to fall back to.
          WHERE j.status IN ('complete','closed')
            AND j.completed_on IS NOT NULL
            AND i.retainage_cents > 0
          GROUP BY j.id, j.job_no, j.name, j.completed_on
         HAVING SUM(i.retainage_cents - LEAST(i.retainage_cents,
                      GREATEST(0, i.paid_cents - i.due_now_cents))) > 0
          ORDER BY 5 DESC
          LIMIT 10`,
      ),
    ]);

    return {
      lateInvoices: late.rows.map((r) => ({
        invoiceId: r.id,
        invoiceNo: Number(r.invoice_no),
        customerName: r.customer_name,
        cents: Number(r.open_cents),
        daysLate: Number(r.days_late) - 30,
      })),
      lateBills: bills.rows.map((r) => ({
        billId: r.id,
        vendorName: r.vendor_name,
        cents: Number(r.open_cents),
        daysLate: Number(r.days_late),
      })),
      unansweredBankLines: Number(bank.rows[0]!.n),
      completedNotInvoiced: completed.rows.map((r) => ({
        jobId: r.id,
        jobNo: Number(r.job_no),
        name: r.name,
      })),
      cashOnHandCents: Number(cash.rows[0]!.n),
      overdueRetainage: retainage.rows.map((r) => ({
        jobId: r.id,
        jobNo: Number(r.job_no),
        name: r.name,
        cents: Number(r.cents),
        daysOverdue: Number(r.days_overdue),
      })),
    };
  });
}
