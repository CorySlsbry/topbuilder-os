import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { postJournalEntryTx, type EntryLineInput } from "@/modules/ledger";
import { computeBurdenedLabor, type BurdenRate } from "@/modules/job-costing";
import { DEFAULT_POSTING_ACCOUNTS } from "@/modules/field-ops";
import { splitWeeklyOt, weekStartOf } from "./ot";

export class WorkforceError extends HttpError {
  constructor(status: 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

const JOB_COST = DEFAULT_POSTING_ACCOUNTS.jobCost; // 1430
export const ACCRUED_WAGES = "2400"; // Accrued salaries and wages payable
export const ACCRUED_BURDEN = "2425"; // Other accrued expenses

// ------------------------------------------------------------ WC classes
export interface WcClassRow {
  id: string;
  classCode: string;
  description: string;
  ratePer100Cents: number;
}

export async function upsertWcClass(
  scope: TenantScope,
  input: { classCode: string; description?: string; ratePer100Cents: number },
): Promise<void> {
  await withTenant(scope, async (c) => {
    await c.query(
      `INSERT INTO wc_classes (tenant_id, class_code, description, rate_per100_cents)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, class_code) DO UPDATE SET
         description = EXCLUDED.description,
         rate_per100_cents = EXCLUDED.rate_per100_cents`,
      [scope.tenantId, input.classCode.trim(), input.description ?? "", input.ratePer100Cents],
    );
  });
}

export async function listWcClasses(scope: TenantScope): Promise<WcClassRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT id, class_code AS "classCode", description,
              rate_per100_cents AS "ratePer100Cents"
         FROM wc_classes ORDER BY class_code`,
    );
    return rows as WcClassRow[];
  });
}

// --------------------------------------------------------------- workers
export interface WorkerInput {
  name: string;
  trade?: string;
  wcClassCode: string;
  baseHourlyCents: number;
  ficaBps?: number;
  unemploymentBps?: number;
  benefitsHourlyCents?: number;
  otherBps?: number;
}

export interface WorkerRow {
  id: string;
  name: string;
  trade: string;
  wcClassCode: string;
  baseHourlyCents: number;
  ficaBps: number;
  unemploymentBps: number;
  benefitsHourlyCents: number;
  otherBps: number;
  active: boolean;
}

export async function createWorker(scope: TenantScope, input: WorkerInput): Promise<string> {
  return withTenant(scope, async (c) => {
    const wc = await c.query(`SELECT 1 FROM wc_classes WHERE class_code = $1`, [
      input.wcClassCode,
    ]);
    if (wc.rows.length === 0) throw new WorkforceError(422, "unknown_wc_class");
    try {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO workers (tenant_id, name, trade, wc_class_code, base_hourly_cents,
                              fica_bps, unemployment_bps, benefits_hourly_cents, other_bps)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          scope.tenantId,
          input.name.trim(),
          input.trade ?? "",
          input.wcClassCode.trim(),
          input.baseHourlyCents,
          input.ficaBps ?? 765,
          input.unemploymentBps ?? 0,
          input.benefitsHourlyCents ?? 0,
          input.otherBps ?? 0,
        ],
      );
      return rows[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new WorkforceError(409, "worker_exists");
      }
      throw err;
    }
  });
}

export async function listWorkers(scope: TenantScope): Promise<WorkerRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT id, name, trade, wc_class_code AS "wcClassCode",
              base_hourly_cents AS "baseHourlyCents", fica_bps AS "ficaBps",
              unemployment_bps AS "unemploymentBps",
              benefits_hourly_cents AS "benefitsHourlyCents",
              other_bps AS "otherBps", active
         FROM workers WHERE active ORDER BY name`,
    );
    return (rows as (WorkerRow & { baseHourlyCents: string; benefitsHourlyCents: string })[]).map(
      (r) => ({
        ...r,
        baseHourlyCents: Number(r.baseHourlyCents),
        benefitsHourlyCents: Number(r.benefitsHourlyCents),
      }),
    );
  });
}

// ----------------------------------------------------------------- crews
export async function createCrew(scope: TenantScope, name: string): Promise<string> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO crews (tenant_id, name) VALUES ($1,$2)
       ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [scope.tenantId, name.trim()],
    );
    return rows[0]!.id;
  });
}

export async function setCrewMembers(
  scope: TenantScope,
  crewId: string,
  workerIds: string[],
): Promise<void> {
  await withTenant(scope, async (c) => {
    await c.query(`DELETE FROM crew_members WHERE crew_id = $1`, [crewId]);
    for (const w of workerIds) {
      await c.query(
        `INSERT INTO crew_members (tenant_id, crew_id, worker_id) VALUES ($1,$2,$3)`,
        [scope.tenantId, crewId, w],
      );
    }
  });
}

export async function listCrews(
  scope: TenantScope,
): Promise<{ id: string; name: string; members: string[] }[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT cr.id, cr.name,
              COALESCE(ARRAY_AGG(w.name ORDER BY w.name)
                       FILTER (WHERE w.id IS NOT NULL), '{}') AS members
         FROM crews cr
         LEFT JOIN crew_members cm ON cm.crew_id = cr.id
         LEFT JOIN workers w ON w.id = cm.worker_id
        GROUP BY cr.id, cr.name ORDER BY cr.name`,
    );
    return rows as { id: string; name: string; members: string[] }[];
  });
}

// ------------------------------------------------------------------ time
export interface TimeInput {
  workerId: string;
  jobId: string;
  workDate: string;
  hoursX100: number;
  costCode?: string;
  notes?: string;
}

export async function logTime(scope: TenantScope, input: TimeInput): Promise<string> {
  if (!Number.isInteger(input.hoursX100) || input.hoursX100 <= 0 || input.hoursX100 > 24_00) {
    throw new WorkforceError(422, "invalid_hours");
  }
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO time_entries (tenant_id, job_id, worker_id, work_date, hours_x100,
                                 ot_x100, cost_code, notes, user_id)
       VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8) RETURNING id`,
      [
        scope.tenantId,
        input.jobId,
        input.workerId,
        input.workDate,
        input.hoursX100,
        input.costCode ?? "4100",
        input.notes ?? "",
        scope.uid,
      ],
    );
    return rows[0]!.id;
  });
}

export interface PendingWeek {
  workerId: string;
  workerName: string;
  weekStart: string;
  entryCount: number;
  totalHoursX100: number;
  otHoursX100: number;
  wagesCents: number;
  burdenCents: number;
  totalCents: number;
  jobNos: number[];
}

interface PendingEntryRow {
  id: string;
  worker_id: string;
  worker_name: string;
  job_id: string;
  job_no: number;
  work_date: string;
  hours_x100: number;
  cost_code: string | null;
  base_hourly_cents: string;
  fica_bps: number;
  unemployment_bps: number;
  benefits_hourly_cents: string;
  other_bps: number;
  wc_rate: number;
}

async function pendingEntries(c: PoolClient): Promise<PendingEntryRow[]> {
  const { rows } = await c.query(
    `SELECT te.id, te.worker_id, w.name AS worker_name, te.job_id, j.job_no,
            te.work_date::text AS work_date, te.hours_x100, te.cost_code,
            w.base_hourly_cents, w.fica_bps, w.unemployment_bps,
            w.benefits_hourly_cents, w.other_bps,
            wc.rate_per100_cents AS wc_rate
       FROM time_entries te
       JOIN workers w ON w.id = te.worker_id
       JOIN wc_classes wc ON wc.tenant_id = w.tenant_id AND wc.class_code = w.wc_class_code
       JOIN jobs j ON j.id = te.job_id
      WHERE te.status = 'pending' AND te.worker_id IS NOT NULL
      ORDER BY te.work_date`,
  );
  return rows as PendingEntryRow[];
}

function rateOf(e: PendingEntryRow): BurdenRate {
  return {
    baseHourlyCents: Number(e.base_hourly_cents),
    ficaBps: e.fica_bps,
    unemploymentBps: e.unemployment_bps,
    wcPer100Cents: e.wc_rate,
    benefitsHourlyCents: Number(e.benefits_hourly_cents),
    otherBps: e.other_bps,
  };
}

/**
 * Burden every pending time entry, ONCE, in the one place both views read.
 *
 * ⛔ THE TRAP THIS EXISTS TO PREVENT: overtime is a property of a worker's
 * WEEK, not of a job. `splitWeeklyOt` allocates OT across everything one
 * person worked in one week. Group by job FIRST and then split, and a worker
 * who put 30 hours on job A and 20 on job B has no overtime on either — when
 * in fact they worked 50 and 10 of those hours are time-and-a-half.
 *
 * So the grouping is always worker+week, the burden is computed per ENTRY, and
 * whoever wants a by-job total re-sums those per-entry figures afterwards.
 * Having one implementation is what makes it impossible for the by-week screen
 * and the by-job number to disagree — a test asserts their totals tie.
 */
interface BurdenedEntry {
  entry: PendingEntryRow;
  wagesCents: number;
  burdenCents: number;
  otX100: number;
}

function burdenPending(entries: PendingEntryRow[]): Map<string, BurdenedEntry[]> {
  const groups = new Map<string, PendingEntryRow[]>();
  for (const e of entries) {
    const key = `${e.worker_id}|${weekStartOf(e.work_date)}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const out = new Map<string, BurdenedEntry[]>();
  for (const [key, g] of groups) {
    const splits = splitWeeklyOt(
      g.map((e) => ({ id: e.id, workDate: e.work_date, hoursX100: e.hours_x100 })),
    );
    const byId = new Map(splits.map((s) => [s.id, s]));
    out.set(
      key,
      g.map((e) => {
        const s = byId.get(e.id)!;
        const b = computeBurdenedLabor(s.straightX100, s.otX100, rateOf(e));
        return { entry: e, wagesCents: b.wagesCents, burdenCents: b.burdenCents, otX100: s.otX100 };
      }),
    );
  }
  return out;
}

/** Pending labor rolled up BY JOB, fully burdened.
 *
 *  What makes "what did this job make me?" true for the whole week rather than
 *  only on Friday: until somebody posts a week, those hours contribute ZERO to
 *  cost_entries, so a job looks more profitable than it is by exactly its
 *  entire labor content. */
export interface PendingLaborByJob {
  jobId: string;
  jobNo: number;
  hoursX100: number;
  wagesCents: number;
  burdenCents: number;
  totalCents: number;
  oldestWorkDate: string;
  /** Fewer than 2 and the amount IS one person's burdened pay rate, by
   *  subtraction. The disclosure setting says so in plain words. */
  workerCount: number;
}

export async function listPendingLaborByJob(scope: TenantScope): Promise<PendingLaborByJob[]> {
  return withTenant(scope, async (c) => {
    const burdened = burdenPending(await pendingEntries(c));
    const byJob = new Map<string, PendingLaborByJob & { workers: Set<string> }>();
    for (const group of burdened.values()) {
      for (const b of group) {
        const jobId = b.entry.job_id;
        const row = byJob.get(jobId) ?? {
          jobId,
          jobNo: Number(b.entry.job_no),
          hoursX100: 0,
          wagesCents: 0,
          burdenCents: 0,
          totalCents: 0,
          oldestWorkDate: b.entry.work_date,
          workerCount: 0,
          workers: new Set<string>(),
        };
        row.hoursX100 += b.entry.hours_x100;
        row.wagesCents += b.wagesCents;
        row.burdenCents += b.burdenCents;
        row.totalCents += b.wagesCents + b.burdenCents;
        if (b.entry.work_date < row.oldestWorkDate) row.oldestWorkDate = b.entry.work_date;
        row.workers.add(b.entry.worker_id);
        byJob.set(jobId, row);
      }
    }
    return [...byJob.values()]
      .map(({ workers, ...r }) => ({ ...r, workerCount: workers.size }))
      .sort((a, b) => a.jobNo - b.jobNo);
  });
}

/** Preview: pending time grouped by worker + week, fully burdened. */
export async function listPendingWeeks(scope: TenantScope): Promise<PendingWeek[]> {
  return withTenant(scope, async (c) => {
    const burdened = burdenPending(await pendingEntries(c));
    const out: PendingWeek[] = [];
    for (const [key, group] of burdened) {
      const [workerId, weekStart] = key.split("|") as [string, string];
      const g = group.map((b) => b.entry);
      const wages = group.reduce((t, b) => t + b.wagesCents, 0);
      const burden = group.reduce((t, b) => t + b.burdenCents, 0);
      const ot = group.reduce((t, b) => t + b.otX100, 0);
      out.push({
        workerId,
        workerName: g[0]!.worker_name,
        weekStart,
        entryCount: g.length,
        totalHoursX100: g.reduce((t, e) => t + e.hours_x100, 0),
        otHoursX100: ot,
        wagesCents: wages,
        burdenCents: burden,
        totalCents: wages + burden,
        jobNos: [...new Set(g.map((e) => Number(e.job_no)))].sort((a, b) => a - b),
      });
    }
    return out.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  });
}

/**
 * Post one worker-week: recompute the OT split + burden from the DB (fresh
 * ground truth, never from a card payload), then ONE journal entry — DR
 * 1430 per job/cost-code at the burdened amount / CR 2400 wages + CR 2425
 * burden — plus cost_entries rows, and lock the time entries as posted.
 */
export async function postWorkerWeek(
  scope: TenantScope,
  workerId: string,
  weekStart: string,
): Promise<{ journalEntryId: string; totalCents: number; entryCount: number }> {
  return withTenant(scope, (c) => postWorkerWeekTx(c, scope, workerId, weekStart));
}

export async function postWorkerWeekTx(
  c: PoolClient,
  scope: TenantScope,
  workerId: string,
  weekStart: string,
): Promise<{ journalEntryId: string; totalCents: number; entryCount: number }> {
  const all = await pendingEntries(c);
  const g = all.filter(
    (e) => e.worker_id === workerId && weekStartOf(e.work_date) === weekStart,
  );
  if (g.length === 0) throw new WorkforceError(404, "no_pending_time_for_week");

  const splits = splitWeeklyOt(
    g.map((e) => ({ id: e.id, workDate: e.work_date, hoursX100: e.hours_x100 })),
  );
  const byId = new Map(splits.map((s) => [s.id, s]));

  // Per-entry burden -> aggregate DR lines by job + cost code.
  const drByKey = new Map<string, { jobId: string; costCode: string; cents: number }>();
  const perEntry = new Map<string, { wages: number; burden: number; ot: number }>();
  let wagesTotal = 0;
  let burdenTotal = 0;
  for (const e of g) {
    const s = byId.get(e.id)!;
    const b = computeBurdenedLabor(s.straightX100, s.otX100, rateOf(e));
    wagesTotal += b.wagesCents;
    burdenTotal += b.burdenCents;
    perEntry.set(e.id, { wages: b.wagesCents, burden: b.burdenCents, ot: s.otX100 });
    const costCode = e.cost_code ?? "4100";
    const key = `${e.job_id}|${costCode}`;
    const cur = drByKey.get(key) ?? { jobId: e.job_id, costCode, cents: 0 };
    cur.cents += b.totalCents;
    drByKey.set(key, cur);
  }

  const lines: EntryLineInput[] = [...drByKey.values()].map((d) => ({
    accountCode: JOB_COST,
    debitCents: d.cents,
    jobId: d.jobId,
    costCode: d.costCode,
  }));
  if (wagesTotal > 0) lines.push({ accountCode: ACCRUED_WAGES, creditCents: wagesTotal });
  if (burdenTotal > 0) lines.push({ accountCode: ACCRUED_BURDEN, creditCents: burdenTotal });

  const journalEntryId = await postJournalEntryTx(c, scope, {
    occurredOn: weekStart,
    memo: `Burdened labor, ${g[0]!.worker_name}, week of ${weekStart}`,
    sourceType: "labor-week",
    sourceId: workerId, // source_id is a uuid column; the week lives in the memo

    lines,
  });

  for (const e of g) {
    const s = byId.get(e.id)!;
    const p = perEntry.get(e.id)!;
    await c.query(
      `UPDATE time_entries SET status = 'posted', journal_entry_id = $2,
              ot_x100 = $3, wages_cents = $4, burden_cents = $5
        WHERE id = $1`,
      [e.id, journalEntryId, s.otX100, p.wages, p.burden],
    );
    await c.query(
      `INSERT INTO cost_entries (tenant_id, job_id, cost_code, kind, amount_cents,
         memo, source_type, journal_entry_id, occurred_on, created_by)
       VALUES ($1,$2,$3,'labor',$4,$5,'time',$6,$7,$8)`,
      [
        scope.tenantId,
        e.job_id,
        e.cost_code ?? "4100",
        p.wages + p.burden,
        `${g[0]!.worker_name} ${(e.hours_x100 / 100).toFixed(2)}h`,
        journalEntryId,
        e.work_date,
        scope.uid,
      ],
    );
  }

  return {
    journalEntryId,
    totalCents: wagesTotal + burdenTotal,
    entryCount: g.length,
  };
}

// ---------------------------------------------------------------- payroll
// runPayroll was removed 2026-07-26: payroll is ADP's job, not ours.
// We accrue burdened labor to each job (postWorkerWeekTx above) because
// that is what makes job profit true. Clearing the accrual happens when
// ADP's debit lands in the bank feed and is reconciled — the path that
// already exists — so there is no 'run payroll' button to press here.

/** Names + ids only — for time logging / dispatch selects. No rates. */
export async function listRoster(
  scope: TenantScope,
): Promise<{ id: string; name: string }[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM workers WHERE active ORDER BY name`,
    );
    return rows;
  });
}
