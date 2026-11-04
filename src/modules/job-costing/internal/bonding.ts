import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { postJournalEntryTx } from "@/modules/ledger";
import {
  computeCipRow,
  computeFadeRow,
  computeSuretyRatios,
  explainCip,
  explainFade,
  explainRatios,
  summarizeFade,
  type CipRow,
  type FadeRow,
  type FadeSummary,
  type SuretyRatios,
} from "./money/surety";

export class BondingError extends HttpError {
  constructor(status: 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

/**
 * The bonding package: the four schedules a surety underwriter asks for,
 * generated from the shop's own general ledger.
 *
 * This does not make a set of books "bondable" — a CPA still compiles,
 * reviews or audits them and the underwriter still underwrites the people.
 * What it does claim, and what the tie-out below proves, is that the
 * schedules AGREE WITH THE LEDGER by construction. That is the part that
 * normally costs a contractor two weeks of their accountant's time.
 */

// ═════════════════════════════════════════ 1. contracts in progress

export interface CipScheduleRow extends CipRow {
  jobId: string;
  jobNo: number;
  name: string;
  customerName: string;
  ownerName: string | null;
  contractType: string;
  bonded: boolean;
  bondNumber: string | null;
  suretyName: string | null;
  startedOn: string | null;
  estCompletionOn: string | null;
  status: string;
  /**
   * How many days since the owner last updated the estimate-to-complete.
   * `flags.staleEtc` says THAT it is old; this says HOW old, which is the
   * part that makes somebody act. Null when no ETC has ever been entered —
   * in which case staleEtc is false too (see wip.ts).
   */
  etcAgeDays: number | null;
}

export interface CipSchedule {
  asOf: string;
  rows: CipScheduleRow[];
  totals: {
    contractCents: number;
    pendingChangeOrderCents: number;
    estTotalCostCents: number;
    estGrossProfitCents: number;
    costsToDateCents: number;
    earnedRevenueCents: number;
    grossProfitEarnedCents: number;
    billedToDateCents: number;
    retainageHeldCents: number;
    underbilledCents: number;
    overbilledCents: number;
  };
  /**
   * Does the schedule agree with the general ledger?
   *
   * The two POC accounts (1265 costs in excess of billings, 2480 billings in
   * excess) only carry a balance if a WIP adjusting entry has been posted.
   * Rather than quietly showing a schedule that ties to nothing, the report
   * says out loud whether it ties, by how much, and what to do about it.
   */
  tieOut: {
    ledgerUnderbilledCents: number;
    ledgerOverbilledCents: number;
    underDeltaCents: number;
    overDeltaCents: number;
    tied: boolean;
    lastAdjustmentOn: string | null;
  };
  explain: string;
}

export async function getCipSchedule(
  scope: TenantScope,
  asOf?: string,
): Promise<CipSchedule> {
  return withTenant(scope, async (c) => {
    const on = asOf ?? (await c.query<{ d: string }>("SELECT CURRENT_DATE::text AS d")).rows[0]!.d;

    // Set-based, not per-job. A 40-job shop used to cost 201 round trips on
    // the WIP screen; the same mistake here would be worse because this
    // report is what somebody opens while their agent waits on the phone.
    const { rows } = await c.query<{
      id: string;
      job_no: string;
      name: string;
      customer_name: string;
      owner_name: string | null;
      contract_type: string;
      bonded: boolean;
      bond_number: string | null;
      surety_name: string | null;
      started_on: string | null;
      est_completion_on: string | null;
      status: string;
      contract_cents: string;
      budget_cents: string;
      etc_cents: string | null;
      etc_age_days: string | null;
      costs_cents: string;
      billed_cents: string;
      retainage_cents: string;
      pending_co_cents: string;
    }>(
      `SELECT j.id, j.job_no, j.name,
              cu.name AS customer_name, j.owner_name, j.contract_type,
              j.bonded, j.bond_number, j.surety_name,
              j.started_on::text, j.est_completion_on::text, j.status,
              j.contract_cents, j.budget_cents,
              j.est_cost_to_complete_cents AS etc_cents,
              EXTRACT(DAY FROM now() - j.etc_updated_at)::text AS etc_age_days,
              COALESCE(ce.total, 0)  AS costs_cents,
              COALESCE(iv.total, 0)  AS billed_cents,
              COALESCE(iv.retain, 0) AS retainage_cents,
              COALESCE(co.total, 0)  AS pending_co_cents
         FROM jobs j
         JOIN customers cu ON cu.id = j.customer_id
         LEFT JOIN (
           SELECT job_id, SUM(amount_cents) AS total
             FROM cost_entries WHERE occurred_on <= $1 GROUP BY job_id
         ) ce ON ce.job_id = j.id
         LEFT JOIN (
           SELECT job_id,
                  -- NET of member discounts. This figure reaches a surety
                  -- through the CIP schedule and the general ledger through
                  -- postWipAdjustment(); the gross list price is neither
                  -- billed nor collectable.
                  SUM(net_subtotal_cents) AS total,
                  SUM(retainage_cents)    AS retain
             FROM invoices
            WHERE status <> 'void' AND issued_on <= $1
            GROUP BY job_id
         ) iv ON iv.job_id = j.id
         LEFT JOIN (
           -- Sent but NOT approved. Approved ones are already inside
           -- contract_cents through the contract-movements ledger.
           SELECT job_id, SUM(total_cents) AS total
             FROM change_orders WHERE status IN ('draft','sent') GROUP BY job_id
         ) co ON co.job_id = j.id
        WHERE j.status IN ('scheduled','in-progress','complete')
          AND (j.contract_cents > 0 OR COALESCE(ce.total,0) > 0)
        ORDER BY j.job_no`,
      [on],
    );

    const out: CipScheduleRow[] = rows.map((r) => {
      const row = computeCipRow({
        contractCents: Number(r.contract_cents),
        pendingChangeOrderCents: Number(r.pending_co_cents),
        costsToDateCents: Number(r.costs_cents),
        // ⛔ THE SAME FALLBACK buildCosting USES, and it has to be.
        // `?? 0` meant estimated total cost equalled costs-to-date on any
        // job with no ETC typed in — 100% complete, fully earned, on a job
        // that might be a week old. /wip showed one number and /bonding
        // showed another for the same job, and it is the BONDING one that
        // postWipAdjustment journalizes into 1265, 2480 and revenue.
        // One costing definition, or the ledger disagrees with the report
        // that produced it.
        estCostToCompleteCents:
          r.etc_cents === null
            ? Math.max(0, Number(r.budget_cents) - Number(r.costs_cents))
            : Number(r.etc_cents),
        billedToDateCents: Number(r.billed_cents),
        retainageHeldCents: Number(r.retainage_cents),
        etcAgeDays: r.etc_age_days === null ? undefined : Number(r.etc_age_days),
      });
      return {
        ...row,
        jobId: r.id,
        jobNo: Number(r.job_no),
        name: r.name,
        customerName: r.customer_name,
        ownerName: r.owner_name,
        contractType: r.contract_type,
        bonded: r.bonded,
        bondNumber: r.bond_number,
        suretyName: r.surety_name,
        startedOn: r.started_on,
        estCompletionOn: r.est_completion_on,
        status: r.status,
        etcAgeDays: r.etc_age_days === null ? null : Number(r.etc_age_days),
      };
    });

    const sum = (f: (r: CipScheduleRow) => number) => out.reduce((t, r) => t + f(r), 0);
    const totals = {
      contractCents: sum((r) => r.contractCents),
      pendingChangeOrderCents: sum((r) => r.pendingChangeOrderCents),
      estTotalCostCents: sum((r) => r.estTotalCostCents),
      estGrossProfitCents: sum((r) => r.estGrossProfitCents),
      costsToDateCents: sum((r) => r.costsToDateCents),
      earnedRevenueCents: sum((r) => r.earnedRevenueCents),
      grossProfitEarnedCents: sum((r) => r.grossProfitEarnedCents),
      billedToDateCents: sum((r) => r.billedToDateCents),
      retainageHeldCents: sum((r) => r.retainageHeldCents),
      // ⛔ SUMMED SEPARATELY, NEVER NETTED. $40k underbilled on one job and
      // $40k overbilled on another is not "fine" — it is one invoice nobody
      // sent and one customer who has paid for work still owed.
      underbilledCents: sum((r) => r.underbilledCents),
      overbilledCents: sum((r) => r.overbilledCents),
    };

    const ledger = await pocBalances(c, on);
    const last = await c.query<{ d: string }>(
      "SELECT MAX(as_of)::text AS d FROM wip_adjustments WHERE as_of <= $1",
      [on],
    );

    return {
      asOf: on,
      rows: out,
      totals,
      tieOut: {
        ledgerUnderbilledCents: ledger.under,
        ledgerOverbilledCents: ledger.over,
        underDeltaCents: totals.underbilledCents - ledger.under,
        overDeltaCents: totals.overbilledCents - ledger.over,
        tied:
          totals.underbilledCents === ledger.under &&
          totals.overbilledCents === ledger.over,
        lastAdjustmentOn: last.rows[0]?.d ?? null,
      },
      explain: explainCip(out),
    };
  });
}

/** Balances of 1265 / 2480 in the ledger as of a date. */
async function pocBalances(
  c: PoolClient,
  asOf: string,
): Promise<{ under: number; over: number }> {
  const { rows } = await c.query<{ code: string; net: string }>(
    // ⛔ THE DATE FILTER MUST BE INSIDE THE SUBQUERY, NOT ON A SECOND LEFT
    // JOIN. Written as `LEFT JOIN journal_entries e ON … AND e.occurred_on
    // <= $1`, a line dated AFTER the as-of survives — the first LEFT JOIN
    // already kept it and the second merely yields NULL for e.*, while
    // SUM(l.debit_cents - l.credit_cents) reads the line regardless. Every
    // "as of" balance then silently included the future, and this one is
    // what postWipAdjustment() posts the delta against.
    `SELECT a.code, COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::text AS net
       FROM chart_of_accounts a
       LEFT JOIN (
         SELECT l.account_id, l.debit_cents, l.credit_cents
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.occurred_on <= $1
       ) l ON l.account_id = a.id
      WHERE a.code IN ('1265','2480')
      GROUP BY a.code`,
    [asOf],
  );
  const by = new Map(rows.map((r) => [r.code, Number(r.net)]));
  return {
    under: by.get("1265") ?? 0,
    // 2480 is a liability: credits are positive balances, so flip the sign.
    over: -(by.get("2480") ?? 0),
  };
}

// ═════════════════════════════════════════ 2. the WIP adjusting entry

export interface WipAdjustmentResult {
  asOf: string;
  journalEntryId: string | null;
  underDeltaCents: number;
  overDeltaCents: number;
  targetUnderbilledCents: number;
  targetOverbilledCents: number;
  jobsCounted: number;
  alreadyPosted: boolean;
}

/**
 * Post the percentage-of-completion adjustment — the entry that makes the
 * balance sheet agree with the WIP schedule.
 *
 * ⛔ WHY THIS EXISTS AT ALL. Accounts 1265 and 2480 have been in the seeded
 * chart since day one and NOTHING ever posted to them. Over- and
 * under-billings were computed for a screen and never journalized, so the
 * balance sheet an underwriter or a banker reads did not show the WIP asset,
 * and the contracts-in-progress schedule could not be tied to the trial
 * balance. A schedule that does not tie is a schedule an underwriter
 * discounts.
 *
 * ── IT POSTS THE DELTA, NOT THE BALANCE ──────────────────────────────────
 * The entry moves 1265 and 2480 from wherever they are TO the schedule's
 * totals. That makes it idempotent (run it twice and the second run has
 * nothing to move), self-correcting (a later run fixes an earlier wrong one
 * without anybody reversing anything), and safe in a month that has already
 * been closed — because the closed month simply refuses the posting at the
 * trigger, exactly as it does for every other entry.
 *
 * The other side is contract revenue: recognising unbilled earned revenue is
 * what an under-billing IS.
 */
export async function postWipAdjustment(
  scope: TenantScope,
  asOf: string,
  revenueAccountCode = "3100",
): Promise<WipAdjustmentResult> {
  const schedule = await getCipSchedule(scope, asOf);

  return withTenant(scope, async (c) => {
    const dup = await c.query("SELECT id FROM wip_adjustments WHERE as_of = $1", [asOf]);
    if (dup.rowCount && dup.rowCount > 0) {
      throw new BondingError(409, "adjustment_already_posted_for_that_date");
    }

    const underDelta = schedule.tieOut.underDeltaCents;
    const overDelta = schedule.tieOut.overDeltaCents;

    if (underDelta === 0 && overDelta === 0) {
      // Nothing to move. Recorded anyway so the screen can say "checked on
      // the 31st, already tied" rather than leaving a blank.
      await c.query(
        `INSERT INTO wip_adjustments (tenant_id, as_of, underbilled_cents, overbilled_cents,
           under_delta_cents, over_delta_cents, journal_entry_id, jobs_counted, posted_by)
         VALUES ($1,$2,$3,$4,0,0,NULL,$5,$6)`,
        [
          scope.tenantId, asOf, schedule.totals.underbilledCents,
          schedule.totals.overbilledCents, schedule.rows.length, scope.uid,
        ],
      );
      return {
        asOf,
        journalEntryId: null,
        underDeltaCents: 0,
        overDeltaCents: 0,
        targetUnderbilledCents: schedule.totals.underbilledCents,
        targetOverbilledCents: schedule.totals.overbilledCents,
        jobsCounted: schedule.rows.length,
        alreadyPosted: true,
      };
    }

    // 1265 is an asset: an increase is a DEBIT, and the credit recognises the
    // revenue that under-billing represents.
    // 2480 is a liability: an increase is a CREDIT, and the debit removes
    // revenue that was billed before it was earned.
    const lines: { accountCode: string; debitCents?: number; creditCents?: number }[] = [];
    let revenueDelta = 0;

    if (underDelta > 0) {
      lines.push({ accountCode: "1265", debitCents: underDelta });
      revenueDelta += underDelta;
    } else if (underDelta < 0) {
      lines.push({ accountCode: "1265", creditCents: -underDelta });
      revenueDelta -= -underDelta;
    }
    if (overDelta > 0) {
      lines.push({ accountCode: "2480", creditCents: overDelta });
      revenueDelta -= overDelta;
    } else if (overDelta < 0) {
      lines.push({ accountCode: "2480", debitCents: -overDelta });
      revenueDelta += -overDelta;
    }

    if (revenueDelta > 0) {
      lines.push({ accountCode: revenueAccountCode, creditCents: revenueDelta });
    } else if (revenueDelta < 0) {
      lines.push({ accountCode: revenueAccountCode, debitCents: -revenueDelta });
    }

    const journalEntryId = await postJournalEntryTx(c, scope, {
      occurredOn: asOf,
      memo: `Percentage-of-completion adjustment as of ${asOf} (${schedule.rows.length} contracts)`,
      sourceType: "wip-adjustment",
      lines,
    });

    await c.query(
      `INSERT INTO wip_adjustments (tenant_id, as_of, underbilled_cents, overbilled_cents,
         under_delta_cents, over_delta_cents, journal_entry_id, jobs_counted, posted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        scope.tenantId, asOf, schedule.totals.underbilledCents,
        schedule.totals.overbilledCents, underDelta, overDelta,
        journalEntryId, schedule.rows.length, scope.uid,
      ],
    );

    return {
      asOf,
      journalEntryId,
      underDeltaCents: underDelta,
      overDeltaCents: overDelta,
      targetUnderbilledCents: schedule.totals.underbilledCents,
      targetOverbilledCents: schedule.totals.overbilledCents,
      jobsCounted: schedule.rows.length,
      alreadyPosted: false,
    };
  });
}

// ═════════════════════════════════════════ 3. completed contracts + fade

export interface CompletedContractRow extends FadeRow {
  jobId: string;
  jobNo: number;
  name: string;
  customerName: string;
  completedOn: string | null;
  bonded: boolean;
  snapshotCount: number;
}

export interface CompletedContracts {
  from: string;
  to: string;
  rows: CompletedContractRow[];
  summary: FadeSummary;
  explain: string;
}

/**
 * The credibility document.
 *
 * An underwriter reads the contracts-in-progress schedule and asks one thing
 * of it: do I believe the profit these open jobs say they will make? This
 * answers it with the shop's own history — what finished jobs were SOLD at
 * versus what they actually made.
 *
 * The baseline comes from `wip_snapshots`, which this product has been
 * locking all along. Almost no shop this size can produce true historical
 * fade, because almost none of them recorded what they thought at the time.
 */
export async function getCompletedContracts(
  scope: TenantScope,
  from: string,
  to: string,
): Promise<CompletedContracts> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      id: string;
      job_no: string;
      name: string;
      customer_name: string;
      completed_on: string | null;
      bonded: boolean;
      contract_cents: string;
      budget_cents: string;
      costs_cents: string;
      award_contract_cents: string | null;
      last_contract_cents: string | null;
      last_costs_cents: string | null;
      last_etc_cents: string | null;
      snapshots: string;
    }>(
      `SELECT j.id, j.job_no, j.name, cu.name AS customer_name,
              j.completed_on::text, j.bonded,
              j.contract_cents, j.budget_cents,
              COALESCE(ce.total, 0) AS costs_cents,
              mv.award_contract_cents,
              sn.contract_cents AS last_contract_cents,
              sn.costs_to_date_cents AS last_costs_cents,
              sn.etc_cents AS last_etc_cents,
              COALESCE(snc.n, 0) AS snapshots
         FROM jobs j
         JOIN customers cu ON cu.id = j.customer_id
         LEFT JOIN (
           SELECT job_id, SUM(amount_cents) AS total FROM cost_entries GROUP BY job_id
         ) ce ON ce.job_id = j.id
         LEFT JOIN LATERAL (
           -- The ORIGINAL award, before any change order — the number the
           -- job was actually sold at.
           -- seq 1 is always the original award (0043), so this is the
           -- number the job was SOLD at, before any change order.
           SELECT delta_cents AS award_contract_cents
             FROM contract_movements m
            WHERE m.job_id = j.id AND m.seq = 1
         ) mv ON true
         LEFT JOIN LATERAL (
           -- ⛔ BOUNDED BY COMPLETION. Profit fade asks "how wrong was the
           -- estimate while the job was still running?" — so the baseline
           -- has to be the last estimate made while it WAS still running.
           -- Unbounded, this picks up any snapshot taken after the job
           -- closed, by which point the ETC is zero and the snapshot is just
           -- the actual result restated. Fade against it computes to ~0 and
           -- the schedule reports a shop that never misses, which is the one
           -- claim a surety is reading this page to test.
           SELECT contract_cents, costs_to_date_cents, etc_cents
             FROM wip_snapshots s
            WHERE s.job_id = j.id
              AND s.as_of <= j.completed_on
            ORDER BY s.as_of DESC LIMIT 1
         ) sn ON true
         LEFT JOIN (
           SELECT job_id, COUNT(*) AS n FROM wip_snapshots GROUP BY job_id
         ) snc ON snc.job_id = j.id
        WHERE j.status IN ('complete','closed')
          AND j.completed_on BETWEEN $1 AND $2
        ORDER BY j.completed_on DESC, j.job_no`,
      [from, to],
    );

    const out: CompletedContractRow[] = rows.map((r) => {
      const budget = Number(r.budget_cents);
      const award = r.award_contract_cents === null ? null : Number(r.award_contract_cents);
      // The baseline is the ORIGINAL award less the ORIGINAL budget. Both
      // have to exist — a job with no budget has nothing to have faded from,
      // and reporting "0 fade" there would claim it finished exactly as sold.
      const estAtAward = award !== null && budget > 0 ? award - budget : null;

      const lastContract = r.last_contract_cents === null ? null : Number(r.last_contract_cents);
      const lastCosts = r.last_costs_cents === null ? null : Number(r.last_costs_cents);
      const lastEtc = r.last_etc_cents === null ? null : Number(r.last_etc_cents);
      const estAtLast =
        lastContract === null || lastCosts === null || lastEtc === null
          ? null
          : lastContract - (lastCosts + lastEtc);

      const fade = computeFadeRow({
        finalContractCents: Number(r.contract_cents),
        finalCostCents: Number(r.costs_cents),
        estGrossProfitAtAwardCents: estAtAward,
        estGrossProfitAtLastSnapshotCents: estAtLast,
      });
      return {
        ...fade,
        jobId: r.id,
        jobNo: Number(r.job_no),
        name: r.name,
        customerName: r.customer_name,
        completedOn: r.completed_on,
        bonded: r.bonded,
        snapshotCount: Number(r.snapshots),
      };
    });

    const summary = summarizeFade(out);
    return { from, to, rows: out, summary, explain: explainFade(summary) };
  });
}

// ═════════════════════════════════════════ 4. backlog

export interface BacklogRow {
  jobId: string;
  jobNo: number;
  name: string;
  customerName: string;
  status: string;
  contractCents: number;
  /** Contract value not yet earned — the revenue still ahead. */
  remainingRevenueCents: number;
  /** Gross profit still to earn on it, at the current estimate. */
  remainingGrossProfitCents: number;
  startedOn: string | null;
  estCompletionOn: string | null;
  bonded: boolean;
}

export interface Backlog {
  rows: BacklogRow[];
  totals: { contractCents: number; remainingRevenueCents: number; remainingGrossProfitCents: number };
  explain: string;
}

/**
 * What is coming: signed contracts not yet started, plus the unearned part of
 * everything in progress. Answers the underwriter's second question — can
 * they staff and fund what they have already sold?
 */
export async function getBacklog(scope: TenantScope): Promise<Backlog> {
  const cip = await getCipSchedule(scope);
  const rows: BacklogRow[] = cip.rows
    .filter((r) => r.contractCents > r.earnedRevenueCents)
    .map((r) => ({
      jobId: r.jobId,
      jobNo: r.jobNo,
      name: r.name,
      customerName: r.customerName,
      status: r.status,
      contractCents: r.contractCents,
      remainingRevenueCents: r.contractCents - r.earnedRevenueCents,
      remainingGrossProfitCents: r.grossProfitRemainingCents,
      startedOn: r.startedOn,
      estCompletionOn: r.estCompletionOn,
      bonded: r.bonded,
    }));

  const totals = {
    contractCents: rows.reduce((t, r) => t + r.contractCents, 0),
    remainingRevenueCents: rows.reduce((t, r) => t + r.remainingRevenueCents, 0),
    remainingGrossProfitCents: rows.reduce((t, r) => t + r.remainingGrossProfitCents, 0),
  };

  const explain =
    rows.length === 0
      ? "You have no unearned contract value on the books — everything signed has been earned. That is a clean finish and an empty pipeline at the same time."
      : `${rows.length} contract${rows.length === 1 ? "" : "s"} still have work to do. There is revenue still ahead on them, and the profit shown is what today's cost estimates say is left — it moves when those estimates move.`;

  return { rows, totals, explain };
}

// ═════════════════════════════════════════ 5. the ratio panel

export interface RatioPanel {
  asOf: string;
  ratios: SuretyRatios;
  inputs: {
    currentAssetsCents: number;
    currentLiabilitiesCents: number;
    totalAssetsCents: number;
    totalLiabilitiesCents: number;
    equityCents: number;
    intangibleAndRelatedPartyCents: number;
    revenueCents: number;
    arCents: number;
    underbilledCents: number;
    periodDays: number;
  };
  /** Which accounts the CPA has classified, so the panel shows its work. */
  classified: { code: string; name: string; suretyClass: string }[];
  /** True when NOTHING is classified — the panel is then treating every
   *  asset as current, which is usually wrong and always worth saying. */
  unclassified: boolean;
  explain: string;
}

export async function getRatioPanel(
  scope: TenantScope,
  asOf?: string,
  periodDays = 365,
): Promise<RatioPanel> {
  const cip = await getCipSchedule(scope, asOf);

  return withTenant(scope, async (c) => {
    const on = cip.asOf;
    const from = (
      await c.query<{ d: string }>("SELECT ($1::date - $2::int)::text AS d", [on, periodDays])
    ).rows[0]!.d;

    // One pass over the ledger, grouped by the two things that matter:
    // what KIND of account it is, and how the accountant classified it.
    const { rows } = await c.query<{
      type: string;
      surety_class: string | null;
      net: string;
    }>(
      // Same shape, same trap as pocBalances above: the date predicate
      // belongs inside the subquery. A surety reads working capital and
      // net worth off this panel; a future-dated entry in it is a
      // misstatement to a bonding agent, not a rounding difference.
      `SELECT a.type, a.surety_class,
              COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::text AS net
         FROM chart_of_accounts a
         LEFT JOIN (
           SELECT l.account_id, l.debit_cents, l.credit_cents
             FROM journal_lines l
             JOIN journal_entries e ON e.id = l.entry_id
            WHERE e.occurred_on <= $1
         ) l ON l.account_id = a.id
        GROUP BY a.type, a.surety_class`,
      [on],
    );

    let currentAssets = 0;
    let totalAssets = 0;
    let currentLiabilities = 0;
    let totalLiabilities = 0;
    let equity = 0;
    let intangible = 0;

    for (const r of rows) {
      const net = Number(r.net);
      if (r.type === "asset") {
        totalAssets += net;
        // Unclassified defaults to CURRENT. That is right for most of a small
        // contractor's chart and wrong for their trucks — which is exactly
        // why `unclassified` is reported and the screen asks the CPA to
        // classify rather than guessing from account names.
        if (r.surety_class !== "non-current") currentAssets += net;
        if (r.surety_class === "intangible" || r.surety_class === "related-party") {
          intangible += net;
        }
      } else if (r.type === "liability") {
        totalLiabilities += -net; // liabilities carry credit balances
        if (r.surety_class !== "non-current") currentLiabilities += -net;
      } else if (r.type === "equity") {
        equity += -net;
      }
    }

    // Equity on the balance sheet includes the year's earnings, which live in
    // revenue and expense accounts until they are closed out. Adding them in
    // is what makes this agree with a balance sheet a CPA would draw.
    const pl = await c.query<{ net: string }>(
      `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::text AS net
         FROM chart_of_accounts a
         JOIN journal_lines l ON l.account_id = a.id
         JOIN journal_entries e ON e.id = l.entry_id AND e.occurred_on <= $1
        WHERE a.type IN ('revenue','cogs','expense')`,
      [on],
    );
    equity += -Number(pl.rows[0]!.net);

    const rev = await c.query<{ net: string }>(
      `SELECT COALESCE(SUM(l.credit_cents - l.debit_cents), 0)::text AS net
         FROM chart_of_accounts a
         JOIN journal_lines l ON l.account_id = a.id
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE a.type = 'revenue' AND e.occurred_on BETWEEN $1 AND $2`,
      [from, on],
    );

    // AR EXCLUDING retainage: retainage is not past due, it is being held by
    // contract, and folding it into days-in-AR makes a shop look slow at
    // collecting when it is simply doing commercial work.
    const ar = await c.query<{ net: string }>(
      `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::text AS net
         FROM chart_of_accounts a
         JOIN journal_lines l ON l.account_id = a.id
         JOIN journal_entries e ON e.id = l.entry_id AND e.occurred_on <= $1
        WHERE a.code = '1210'`,
      [on],
    );

    const classified = await c.query<{ code: string; name: string; surety_class: string }>(
      `SELECT code, name, surety_class FROM chart_of_accounts
        WHERE surety_class IS NOT NULL ORDER BY code`,
    );

    const inputs = {
      currentAssetsCents: Math.max(0, currentAssets),
      currentLiabilitiesCents: Math.max(0, currentLiabilities),
      totalAssetsCents: Math.max(0, totalAssets),
      totalLiabilitiesCents: Math.max(0, totalLiabilities),
      equityCents: equity,
      intangibleAndRelatedPartyCents: Math.max(0, intangible),
      revenueCents: Math.max(0, Number(rev.rows[0]!.net)),
      arCents: Math.max(0, Number(ar.rows[0]!.net)),
      underbilledCents: cip.totals.underbilledCents,
      periodDays,
    };
    const ratios = computeSuretyRatios(inputs);

    return {
      asOf: on,
      ratios,
      inputs,
      classified: classified.rows.map((r) => ({
        code: r.code,
        name: r.name,
        suretyClass: r.surety_class,
      })),
      unclassified: classified.rowCount === 0,
      explain: explainRatios(ratios),
    };
  });
}

// ═════════════════════════════════════════ 6. credit facilities

export interface CreditFacility {
  id: string;
  lender: string;
  kind: string;
  limitCents: number;
  balanceCents: number;
  rateBps: number | null;
  maturesOn: string | null;
  personallyGuaranteed: boolean;
  notes: string;
}

export async function listCreditFacilities(scope: TenantScope): Promise<CreditFacility[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<CreditFacility & { limit_cents: string; balance_cents: string; rate_bps: number | null }>(
      `SELECT id, lender, kind, limit_cents, balance_cents, rate_bps,
              matures_on::text AS "maturesOn",
              personally_guaranteed AS "personallyGuaranteed", notes
         FROM credit_facilities ORDER BY lender`,
    );
    return rows.map((r) => ({
      id: r.id,
      lender: r.lender,
      kind: r.kind,
      limitCents: Number(r.limit_cents),
      balanceCents: Number(r.balance_cents),
      rateBps: r.rate_bps === null ? null : Number(r.rate_bps),
      maturesOn: r.maturesOn,
      personallyGuaranteed: r.personallyGuaranteed,
      notes: r.notes,
    }));
  });
}

export async function upsertCreditFacility(
  scope: TenantScope,
  input: {
    id?: string;
    lender: string;
    kind: string;
    limitCents: number;
    balanceCents: number;
    rateBps?: number | null;
    maturesOn?: string | null;
    personallyGuaranteed?: boolean;
    notes?: string;
  },
): Promise<void> {
  if (input.balanceCents > input.limitCents && input.kind === "line-of-credit") {
    throw new BondingError(422, "balance_exceeds_limit");
  }
  await withTenant(scope, async (c) => {
    if (input.id) {
      await c.query(
        `UPDATE credit_facilities
            SET lender=$2, kind=$3, limit_cents=$4, balance_cents=$5, rate_bps=$6,
                matures_on=$7, personally_guaranteed=$8, notes=$9,
                updated_by=$10, updated_at=now()
          WHERE id=$1`,
        [
          input.id, input.lender.trim(), input.kind, input.limitCents, input.balanceCents,
          input.rateBps ?? null, input.maturesOn ?? null,
          input.personallyGuaranteed ?? false, input.notes ?? "", scope.uid,
        ],
      );
      return;
    }
    await c.query(
      `INSERT INTO credit_facilities (tenant_id, lender, kind, limit_cents, balance_cents,
         rate_bps, matures_on, personally_guaranteed, notes, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        scope.tenantId, input.lender.trim(), input.kind, input.limitCents, input.balanceCents,
        input.rateBps ?? null, input.maturesOn ?? null,
        input.personallyGuaranteed ?? false, input.notes ?? "", scope.uid,
      ],
    );
  });
}

export async function deleteCreditFacility(scope: TenantScope, id: string): Promise<void> {
  await withTenant(scope, async (c) => {
    await c.query("DELETE FROM credit_facilities WHERE id = $1", [id]);
  });
}

/** Classify one account for the tangible-net-worth calculation. */
export async function setSuretyClass(
  scope: TenantScope,
  code: string,
  suretyClass: "intangible" | "related-party" | "non-current" | null,
): Promise<void> {
  await withTenant(scope, async (c) => {
    const r = await c.query(
      "UPDATE chart_of_accounts SET surety_class = $2 WHERE code = $1",
      [code, suretyClass],
    );
    if (r.rowCount === 0) throw new BondingError(404, "account_not_found");
  });
}
