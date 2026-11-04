import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { postJournalEntryTx } from "@/modules/ledger";
import { issueAgreementInvoice } from "@/modules/sales-invoicing";
import { deferredBalanceCents, visitDueDates, visitReleaseSchedule } from "./rec";

/**
 * Service agreements — the membership engine.
 *
 * The policy this file implements (Cory 2026-08-03):
 *   ANNUAL prepay parks in 2430 Deferred income and is earned PER COMPLETED
 *   VISIT via the stored release schedule; the stub releases at rollover.
 *   MONTHLY fees earn in their month (CR 3138 directly). Discounts post to
 *   3490 as contra-revenue at invoice time — handled by sales-invoicing,
 *   composed by the route.
 *
 * Money choreography lives HERE; invoice rows live in sales-invoicing (its
 * table, its port). The ledger is only ever touched through its port.
 */

export class AgreementError extends HttpError {
  constructor(status: 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

const DEFERRED = "2430"; // NAHB: Deferred income — advance payments not yet earned
const AGREEMENT_REVENUE = "3138"; // created per tenant in 0037

// ---------------------------------------------------------------- plans
export interface PlanInput {
  name: string;
  billing: "monthly" | "annual";
  priceCents: number;
  visitsPerYear: number;
  discountBps: number;
  targetMonths: number[];
}

export interface PlanRow extends PlanInput {
  id: string;
  active: boolean;
  memberCount: number;
}

export async function createPlan(scope: TenantScope, input: PlanInput): Promise<string> {
  if (input.priceCents < 0 || !Number.isSafeInteger(input.priceCents)) {
    throw new AgreementError(422, "price_invalid");
  }
  if (input.targetMonths.some((m) => m < 1 || m > 12)) {
    throw new AgreementError(422, "target_months_invalid");
  }
  return withTenant(scope, async (c) => {
    try {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO membership_plans
           (tenant_id, name, billing, price_cents, visits_per_year, discount_bps, target_months)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          scope.tenantId,
          input.name.trim(),
          input.billing,
          input.priceCents,
          input.visitsPerYear,
          input.discountBps,
          input.targetMonths,
        ],
      );
      return rows[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new AgreementError(409, "plan_name_exists");
      }
      throw err;
    }
  });
}

export async function listPlans(scope: TenantScope): Promise<PlanRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT p.id, p.name, p.billing, p.price_cents AS "priceCents",
              p.visits_per_year AS "visitsPerYear", p.discount_bps AS "discountBps",
              p.target_months AS "targetMonths", p.active,
              count(a.id) FILTER (WHERE a.status = 'active')::int AS "memberCount"
         FROM membership_plans p
         LEFT JOIN agreements a ON a.plan_id = p.id
        GROUP BY p.id ORDER BY p.name`,
    );
    return (rows as (PlanRow & { priceCents: string })[]).map((r) => ({
      ...r,
      priceCents: Number(r.priceCents),
    }));
  });
}

export async function setPlanActive(
  scope: TenantScope,
  planId: string,
  active: boolean,
): Promise<void> {
  await withTenant(scope, async (c) => {
    const r = await c.query(`UPDATE membership_plans SET active = $2 WHERE id = $1`, [
      planId,
      active,
    ]);
    if (r.rowCount === 0) throw new AgreementError(404, "plan_not_found");
  });
}

// ------------------------------------------------------------ agreements
export interface AgreementRow {
  id: string;
  planId: string;
  planName: string;
  billing: "monthly" | "annual";
  priceCents: number;
  discountBps: number;
  customerId: string;
  customerName: string;
  status: string;
  startedOn: string;
  periodStart: string;
  periodEnd: string;
  canceledAt: string | null;
  visitsPerYear: number;
  visitsCompleted: number;
  deferredBalanceCents: number;
  autopay: boolean;
}

function addYears(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Enroll a customer. One transaction: agreement + visits + the money.
 *
 *   annual  → invoice for the year, CR 2430 (deferred — nothing earned yet)
 *   monthly → invoice for month one, CR 3138 (that month IS earned when billed)
 *
 * Autopay (monthly + saved card) is charged by the caller AFTER this commits
 * — a Stripe call inside the transaction would hold a row lock across a
 * network round-trip, and its failure must not unwind the enrollment.
 */
export async function enroll(
  scope: TenantScope,
  input: {
    planId: string;
    customerId: string;
    startOn: string;
    paymentMethodId?: string;
    equipmentIds?: string[];
  },
): Promise<{ agreementId: string; invoiceId: string; invoiceNo: number }> {
  return withTenant(scope, async (c) => {
    const plan = await c.query<{
      name: string;
      billing: "monthly" | "annual";
      price_cents: string;
      visits_per_year: number;
      target_months: number[];
      active: boolean;
    }>(`SELECT name, billing, price_cents, visits_per_year, target_months, active
          FROM membership_plans WHERE id = $1`, [input.planId]);
    const p = plan.rows[0];
    if (!p) throw new AgreementError(404, "plan_not_found");
    if (!p.active) throw new AgreementError(409, "plan_inactive");

    const price = Number(p.price_cents);
    const periodEnd =
      p.billing === "annual" ? addYears(input.startOn, 1) : addMonths(input.startOn, 1);
    const annual = p.billing === "annual";
    const schedule =
      annual && p.visits_per_year > 0 ? visitReleaseSchedule(price, p.visits_per_year) : [];

    const ins = await c.query<{ id: string }>(
      `INSERT INTO agreements
         (tenant_id, plan_id, customer_id, started_on, period_start, period_end,
          payment_method_id, deferred_total_cents, release_schedule, created_by)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        scope.tenantId,
        input.planId,
        input.customerId,
        input.startOn,
        periodEnd,
        input.paymentMethodId ?? null,
        annual ? price : 0,
        schedule,
        scope.uid,
      ],
    );
    const agreementId = ins.rows[0]!.id;

    for (const eq of input.equipmentIds ?? []) {
      await c.query(
        `INSERT INTO agreement_equipment (tenant_id, agreement_id, equipment_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [scope.tenantId, agreementId, eq],
      );
    }

    for (const due of visitDueDates(input.startOn, p.visits_per_year, p.target_months)) {
      await c.query(
        `INSERT INTO agreement_visits (tenant_id, agreement_id, due_on)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [scope.tenantId, agreementId, due],
      );
    }

    // The year's (or month's) bill. Same client → same transaction.
    const invoice = await issueAgreementInvoice(c, scope, {
      agreementId,
      customerId: input.customerId,
      amountCents: price,
      issuedOn: input.startOn,
      memo: annual
        ? `${p.name} — year of ${input.startOn.slice(0, 4)}`
        : `${p.name} — ${input.startOn.slice(0, 7)}`,
      creditAccountCode: annual ? DEFERRED : AGREEMENT_REVENUE,
    });

    return { agreementId, invoiceId: invoice.id, invoiceNo: invoice.invoiceNo };
  });
}

export async function listAgreements(
  scope: TenantScope,
  customerId?: string,
): Promise<AgreementRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT a.id, a.plan_id AS "planId", p.name AS "planName", p.billing,
              p.price_cents AS "priceCents", p.discount_bps AS "discountBps",
              a.customer_id AS "customerId", cu.name AS "customerName",
              a.status, a.started_on::text AS "startedOn",
              a.period_start::text AS "periodStart", a.period_end::text AS "periodEnd",
              a.canceled_at::text AS "canceledAt",
              p.visits_per_year AS "visitsPerYear",
              a.visits_completed AS "visitsCompleted",
              a.deferred_total_cents AS "deferredTotal",
              (a.payment_method_id IS NOT NULL) AS "autopay"
         FROM agreements a
         JOIN membership_plans p ON p.id = a.plan_id
         JOIN customers cu ON cu.id = a.customer_id
        WHERE ($1::uuid IS NULL OR a.customer_id = $1)
        ORDER BY a.created_at DESC LIMIT 300`,
      [customerId ?? null],
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      planId: r.planId as string,
      planName: r.planName as string,
      billing: r.billing as "monthly" | "annual",
      priceCents: Number(r.priceCents),
      discountBps: r.discountBps as number,
      customerId: r.customerId as string,
      customerName: r.customerName as string,
      status: r.status as string,
      startedOn: r.startedOn as string,
      periodStart: r.periodStart as string,
      periodEnd: r.periodEnd as string,
      canceledAt: (r.canceledAt as string) ?? null,
      visitsPerYear: r.visitsPerYear as number,
      visitsCompleted: r.visitsCompleted as number,
      deferredBalanceCents: deferredBalanceCents(
        Number(r.deferredTotal),
        Math.max(r.visitsPerYear as number, 1),
        r.visitsCompleted as number,
      ),
      autopay: r.autopay as boolean,
    }));
  });
}

/**
 * The member benefit lookup invoicing composes with: the best discount among
 * a customer's ACTIVE agreements, zero when none. Routes call this and pass
 * the result into issueInvoice — sales-invoicing never imports agreements.
 */
export async function memberDiscountBps(
  scope: TenantScope,
  customerId: string,
): Promise<number> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ bps: number }>(
      `SELECT COALESCE(MAX(p.discount_bps), 0) AS bps
         FROM agreements a JOIN membership_plans p ON p.id = a.plan_id
        WHERE a.customer_id = $1 AND a.status = 'active'`,
      [customerId],
    );
    return rows[0]?.bps ?? 0;
  });
}

// ---------------------------------------------------------------- visits
export interface VisitRow {
  id: string;
  agreementId: string;
  planName: string;
  customerId: string;
  customerName: string;
  dueOn: string;
  status: string;
  jobId: string | null;
  completedOn: string | null;
  releasedCents: number;
}

export async function listVisits(
  scope: TenantScope,
  status?: "due" | "booked",
): Promise<VisitRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT v.id, v.agreement_id AS "agreementId", p.name AS "planName",
              a.customer_id AS "customerId", cu.name AS "customerName",
              v.due_on::text AS "dueOn", v.status, v.job_id AS "jobId",
              v.completed_on::text AS "completedOn",
              v.released_cents AS "releasedCents"
         FROM agreement_visits v
         JOIN agreements a ON a.id = v.agreement_id
         JOIN membership_plans p ON p.id = a.plan_id
         JOIN customers cu ON cu.id = a.customer_id
        WHERE a.status = 'active' AND ($1::text IS NULL OR v.status = $1)
        ORDER BY v.due_on LIMIT 300`,
      [status ?? null],
    );
    return (rows as (VisitRow & { releasedCents: string })[]).map((r) => ({
      ...r,
      releasedCents: Number(r.releasedCents),
    }));
  });
}

/** Tie a visit to the tune-up job that will fulfil it. */
export async function bookVisit(
  scope: TenantScope,
  visitId: string,
  jobId: string,
): Promise<void> {
  await withTenant(scope, async (c) => {
    const r = await c.query(
      `UPDATE agreement_visits SET status = 'booked', job_id = $2
        WHERE id = $1 AND status = 'due'`,
      [visitId, jobId],
    );
    if (r.rowCount === 0) throw new AgreementError(409, "visit_not_due");
  });
}

/**
 * Complete a visit — the moment deferred revenue becomes EARNED revenue.
 *
 * Locks the agreement row first: two techs closing the spring and fall
 * visits at the same moment must release DIFFERENT schedule slots, not both
 * read visits_completed=0 and both release slot zero. Same law as payBill.
 */
export async function completeVisit(
  scope: TenantScope,
  visitId: string,
  completedOn: string,
): Promise<{ releasedCents: number }> {
  return withTenant(scope, async (c) => {
    const v = await c.query<{
      id: string;
      agreement_id: string;
      status: string;
    }>(
      `SELECT v.id, v.agreement_id, v.status
         FROM agreement_visits v
         JOIN agreements a ON a.id = v.agreement_id
        WHERE v.id = $1
        FOR UPDATE OF a, v`,
      [visitId],
    );
    const visit = v.rows[0];
    if (!visit) throw new AgreementError(404, "visit_not_found");
    if (visit.status === "completed") throw new AgreementError(409, "visit_already_completed");
    if (visit.status === "skipped") throw new AgreementError(409, "visit_skipped");

    const a = await c.query<{
      release_schedule: string[];
      visits_completed: number;
      deferred_total_cents: string;
      plan_name: string;
    }>(
      `SELECT a.release_schedule, a.visits_completed, a.deferred_total_cents,
              p.name AS plan_name
         FROM agreements a JOIN membership_plans p ON p.id = a.plan_id
        WHERE a.id = $1`,
      [visit.agreement_id],
    );
    const ag = a.rows[0]!;

    // Monthly plans (or zero-visit plans) have nothing deferred — the visit
    // is a service obligation, not a revenue event.
    const slot = ag.visits_completed;
    const releasedCents =
      slot < ag.release_schedule.length ? Number(ag.release_schedule[slot]) : 0;

    let journalEntryId: string | null = null;
    if (releasedCents > 0) {
      journalEntryId = await postJournalEntryTx(c, scope, {
        occurredOn: completedOn,
        memo: `${ag.plan_name}: visit ${slot + 1} completed — deferred revenue earned`,
        sourceType: "agreement-visit",
        sourceId: visitId,
        lines: [
          { accountCode: DEFERRED, debitCents: releasedCents },
          { accountCode: AGREEMENT_REVENUE, creditCents: releasedCents },
        ],
      });
    }

    await c.query(
      `UPDATE agreement_visits
          SET status = 'completed', completed_on = $2,
              released_cents = $3, journal_entry_id = $4
        WHERE id = $1`,
      [visitId, completedOn, releasedCents, journalEntryId],
    );
    await c.query(
      `UPDATE agreements SET visits_completed = visits_completed + 1 WHERE id = $1`,
      [visit.agreement_id],
    );
    return { releasedCents };
  });
}

/**
 * Put a rolled-past visit back in play.
 *
 * The tech did the tune-up on the 3rd; the bookkeeper closed the month on the
 * 5th; the rollover ran on the 7th and marked it skipped. That work happened,
 * the customer paid for it, and the revenue belongs to the shop — but
 * `completeVisit` refuses a skipped visit outright and there was no way back.
 *
 * ⛔ ONLY 'period-rolled' CAN BE REOPENED. A visit the customer declined or
 * that could not be delivered is a genuine non-event: reopening it would let
 * somebody recognise revenue for work nobody did, which is the exact failure
 * this whole module exists to prevent.
 */
export async function reopenVisit(scope: TenantScope, visitId: string): Promise<void> {
  await withTenant(scope, async (c) => {
    const { rows } = await c.query<{ status: string; skipped_reason: string | null }>(
      "SELECT status, skipped_reason FROM agreement_visits WHERE id = $1 FOR UPDATE",
      [visitId],
    );
    const v = rows[0];
    if (!v) throw new AgreementError(404, "visit_not_found");
    if (v.status === "completed") throw new AgreementError(409, "visit_already_completed");
    if (v.status !== "skipped") return; // already open — nothing to do
    if (v.skipped_reason !== "period-rolled") {
      throw new AgreementError(409, "visit_was_declined_not_rolled");
    }
    await c.query(
      `UPDATE agreement_visits SET status = 'due', skipped_reason = NULL WHERE id = $1`,
      [visitId],
    );
  });
}

/**
 * Complete the visit a finished JOB satisfies, if there is one.
 *
 * ⛔ THIS IS THE HAND THAT WAS MISSING. `completeVisit` was written, tested
 * and documented as the policy in four places — and had no caller outside the
 * endpoint sweep. So an annual plan's deferred revenue never released per
 * visit; the whole year dumped at rollover, on the plan anniversary, whether
 * or not a single tune-up happened. Eleven monthly P&Ls understated service
 * revenue and the twelfth overstated it.
 *
 * Marking the tune-up job done is the moment the shop KNOWS the obligation
 * was met, and it is a thing a tech already does. Hanging recognition off it
 * removes the busy work rather than adding a second screen to remember.
 *
 * Returns null when the job backs no visit, which is the ordinary case.
 * NEVER throws for a business reason — a job completing must not fail
 * because of a membership. Anything unexpected is logged and swallowed:
 * revenue recognition is important, and it is not more important than the
 * crew being able to close a job.
 */
export async function completeVisitForJob(
  scope: TenantScope,
  jobId: string,
  completedOn: string,
): Promise<{ visitId: string; releasedCents: number } | null> {
  const visitId = await withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT v.id FROM agreement_visits v
         JOIN agreements a ON a.id = v.agreement_id
        WHERE v.job_id = $1 AND v.status IN ('due','booked') AND a.status = 'active'
        LIMIT 1`,
      [jobId],
    );
    return rows[0]?.id ?? null;
  });
  if (!visitId) return null;

  try {
    const r = await completeVisit(scope, visitId, completedOn);
    return { visitId, releasedCents: r.releasedCents };
  } catch (err) {
    // A closed accounting period is the likely one, and it is not the crew's
    // problem to solve at 4pm on a roof. The visit stays open and the
    // bookkeeper completes it from the memberships screen once the period is.
    console.error(`[agreements] visit ${visitId} could not complete with job ${jobId}:`, err);
    return null;
  }
}

// ----------------------------------------------------- lifecycle / cron
/**
 * Cancel: no more billing after the current period; benefits the member
 * already paid for keep running until period_end (that is what they bought).
 * Rollover flips it to 'canceled' when the period lapses. Any deferred
 * balance is reported so the owner can decide about a goodwill credit memo —
 * money moves through the CPA-pair flow, never as a cancel side effect.
 */
export async function cancelAgreement(
  scope: TenantScope,
  agreementId: string,
): Promise<{ deferredBalanceCents: number; periodEnd: string }> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      deferred_total_cents: string;
      release_schedule: string[];
      visits_completed: number;
      period_end: string;
      status: string;
    }>(
      `UPDATE agreements SET canceled_at = COALESCE(canceled_at, now())
        WHERE id = $1 AND status = 'active'
        RETURNING deferred_total_cents, release_schedule, visits_completed,
                  period_end::text, status`,
      [agreementId],
    );
    const a = rows[0];
    if (!a) throw new AgreementError(409, "agreement_not_active");
    const released = a.release_schedule
      .slice(0, a.visits_completed)
      .reduce((s, v) => s + Number(v), 0);
    return {
      deferredBalanceCents: Number(a.deferred_total_cents) - released,
      periodEnd: a.period_end,
    };
  });
}

/**
 * Advance every agreement whose period has lapsed. Runs from the daily cron
 * route; each agreement handled in its own transaction so one bad row can't
 * wedge the whole tenant.
 *
 *   annual, still active   → release any deferred stub (the obligation
 *                            lapsed), open the next year: new schedule, new
 *                            visits, new invoice (CR 2430 again).
 *   monthly, still active  → next month: new invoice (CR 3138). The caller
 *                            charges autopay AFTER commit.
 *   canceled               → release the stub, mark 'canceled'. The member
 *                            got their period; nothing renews.
 */
export async function rolloverDue(
  scope: TenantScope,
  today: string,
): Promise<{
  renewed: number;
  closed: number;
  autopayDue: { agreementId: string; invoiceId: string; amountCents: number; paymentMethodId: string }[];
}> {
  const due = await withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM agreements WHERE status = 'active' AND period_end <= $1
        ORDER BY period_end LIMIT 200`,
      [today],
    );
    return rows.map((r) => r.id);
  });

  let renewed = 0;
  let closed = 0;
  const autopayDue: {
    agreementId: string;
    invoiceId: string;
    amountCents: number;
    paymentMethodId: string;
  }[] = [];

  for (const id of due) {
    // Per-agreement transaction: a poison row stops itself, not the batch.
    await withTenant(scope, async (c) => {
      const { rows } = await c.query<{
        id: string;
        plan_id: string;
        customer_id: string;
        period_end: string;
        canceled_at: string | null;
        deferred_total_cents: string;
        release_schedule: string[];
        visits_completed: number;
        payment_method_id: string | null;
        name: string;
        billing: "monthly" | "annual";
        price_cents: string;
        visits_per_year: number;
        target_months: number[];
      }>(
        `SELECT a.id, a.plan_id, a.customer_id, a.period_end::text, a.canceled_at,
                a.deferred_total_cents, a.release_schedule, a.visits_completed,
                a.payment_method_id,
                p.name, p.billing, p.price_cents, p.visits_per_year, p.target_months
           FROM agreements a JOIN membership_plans p ON p.id = a.plan_id
          WHERE a.id = $1 AND a.status = 'active' AND a.period_end <= $2
          FOR UPDATE OF a`,
        [id, today],
      );
      const a = rows[0];
      if (!a) return; // raced with another cron run — its transaction won

      // 1. The lapsed period's unearned stub becomes earned: the plan year
      //    ended, the obligation to visit ended with it.
      const released = a.release_schedule
        .slice(0, a.visits_completed)
        .reduce((s, v) => s + Number(v), 0);
      const stub = Number(a.deferred_total_cents) - released;
      if (stub > 0) {
        await postJournalEntryTx(c, scope, {
          occurredOn: a.period_end,
          memo: `${a.name}: plan period ended — remaining deferred earned`,
          sourceType: "agreement-rollover",
          sourceId: a.id,
          lines: [
            { accountCode: DEFERRED, debitCents: stub },
            { accountCode: AGREEMENT_REVENUE, creditCents: stub },
          ],
        });
      }
      // ⛔ SCOPED TO THE PERIOD THAT ENDED, AND IT SAYS WHY.
      //
      // This had no date predicate, so it closed out every open visit on the
      // agreement — including ones due in the period about to START. And
      // completeVisit hard-refuses a skipped visit, so the moment a real
      // screen existed, every visit on every agreement that had ever rolled
      // over was un-completable with no route back.
      //
      // A visit the calendar rolled past is not the same fact as one the
      // customer declined. Recording which is what makes the first kind
      // recoverable (see reopenVisit) and the second kind final.
      await c.query(
        `UPDATE agreement_visits
            SET status = 'skipped', skipped_reason = 'period-rolled'
          WHERE agreement_id = $1 AND status IN ('due','booked')
            AND due_on <= $2::date`,
        [a.id, a.period_end],
      );

      // 2. Canceled agreements stop here.
      if (a.canceled_at) {
        await c.query(`UPDATE agreements SET status = 'canceled' WHERE id = $1`, [a.id]);
        closed++;
        return;
      }

      // 3. Renewal: next period, fresh schedule, fresh visits, fresh bill.
      const annual = a.billing === "annual";
      const price = Number(a.price_cents);
      const nextEnd = annual ? addYears(a.period_end, 1) : addMonths(a.period_end, 1);
      const schedule =
        annual && a.visits_per_year > 0 ? visitReleaseSchedule(price, a.visits_per_year) : [];

      await c.query(
        `UPDATE agreements
            SET period_start = $2, period_end = $3, visits_completed = 0,
                deferred_total_cents = $4, release_schedule = $5
          WHERE id = $1`,
        [a.id, a.period_end, nextEnd, annual ? price : 0, schedule],
      );
      if (annual) {
        for (const dueOn of visitDueDates(a.period_end, a.visits_per_year, a.target_months)) {
          await c.query(
            `INSERT INTO agreement_visits (tenant_id, agreement_id, due_on)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [scope.tenantId, a.id, dueOn],
          );
        }
      }
      const invoice = await issueAgreementInvoice(c, scope, {
        agreementId: a.id,
        customerId: a.customer_id,
        amountCents: price,
        issuedOn: a.period_end,
        memo: annual
          ? `${a.name} — renewal ${a.period_end.slice(0, 4)}`
          : `${a.name} — ${a.period_end.slice(0, 7)}`,
        creditAccountCode: annual ? DEFERRED : AGREEMENT_REVENUE,
      });
      renewed++;
      if (a.payment_method_id) {
        autopayDue.push({
          agreementId: a.id,
          invoiceId: invoice.id,
          amountCents: price,
          paymentMethodId: a.payment_method_id,
        });
      }
    });
  }

  return { renewed, closed, autopayDue };
}
