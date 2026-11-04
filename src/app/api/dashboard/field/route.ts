import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { buildFieldTasks, nothingToDo, type FieldFacts } from "@/modules/field-ops";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/**
 * The field dashboard — the other half of the shop's Monday morning.
 *
 * ⛔ WHY THIS EXISTS AS A SECOND ROUTE RATHER THAN A FLAG ON THE FIRST.
 * `/api/dashboard/operating` is walled behind `financials`, correctly — it is
 * the whole business, in dollars, on one screen. The consequence nobody had
 * noticed: a field tech, a dispatcher, or an office person WITHOUT the money
 * wall had no dashboard at all. The nav item was hidden and the route 403'd, so
 * most of a shop's staff logged in to a job list and nothing else.
 *
 * The fix is not "return the owner's payload with the dollars blanked". That
 * would put the ledger on the wire and strip it in the browser, which is a
 * disclosure bug wearing a stylesheet. This route reads DIFFERENT DATA, and the
 * shapes it composes (`FieldFacts`, `FieldTask`) have no field that can hold a
 * dollar amount — the same posture `crewProfitView` takes by asserting
 * forbidden keys are ABSENT rather than zeroed.
 *
 * Composed at the route layer, like the operating dashboard and job profit:
 * this reads across field-ops, scheduling and intake, and an import between any
 * two of those modules would be a cycle waiting to happen.
 */
export const GET = route(async () => {
  const scope = await requireScope({ departments: ["field"] });
  const { facts, counts } = await loadFacts(scope);
  return NextResponse.json({
    asOf: new Date().toISOString(),
    tasks: buildFieldTasks(facts),
    nothingToDo: nothingToDo(facts),
    today: facts.today,
    // ⛔ COUNTED IN SQL, never `facts.x.length`. The fact arrays are LIMITed —
    // they exist to build a top-N task list, not to be totals — so reading
    // their length reports the cap. A shop with 25 unbooked requests would have
    // read "20 waiting" forever, and it would have pinned there exactly as the
    // backlog got bad enough to matter. A number that stops moving is worse
    // than no number, because people trust it.
    counts,
  });
});

/**
 * Every query this screen needs, in one round trip each and none per job.
 *
 * ⛔ NOT `Promise.all` — these share ONE pooled client inside `withTenant`, and
 * node-postgres cannot multiplex a single connection. Running them concurrently
 * on one client is the bug that has bitten this codebase before; the queries are
 * indexed and sequential is genuinely fast here.
 */
interface FieldCounts {
  today: number;
  activeJobs: number;
  waiting: number;
}

async function loadFacts(
  scope: TenantScope,
): Promise<{ facts: FieldFacts; counts: FieldCounts }> {
  return withTenant(scope, async (c) => {
    const today = await c.query(
      `SELECT a.id AS "appointmentId", a.job_id AS "jobId", j.job_no::int AS "jobNo",
              j.name AS "jobName", cu.name AS "customerName",
              a.starts_at::text AS "startsAt", w.name AS "workerName", a.status
         FROM appointments a
         JOIN jobs j ON j.id = a.job_id
         JOIN customers cu ON cu.id = j.customer_id
         LEFT JOIN workers w ON w.id = a.worker_id
        WHERE a.starts_at >= CURRENT_DATE
          AND a.starts_at < CURRENT_DATE + interval '1 day'
          AND a.status <> 'canceled'
        ORDER BY a.starts_at`,
    );

    // Past its end time and still open.
    //
    // ⛔ OLDEST FIRST. This said `ORDER BY a.ends_at DESC` — newest first —
    // which combined with the LIMIT meant the ten MOST RECENT stale
    // appointments were kept and genuinely old ones were discarded before the
    // ranker ever saw them. A job left open for six weeks could never appear on
    // "needs doing" while yesterday's rotated through the visible slots, which
    // inverts the whole point of the list. `ageDays` rides along so the ranker
    // can weight by neglect, the way every other category already does.
    const stale = await c.query(
      `SELECT a.id AS "appointmentId", a.job_id AS "jobId", j.job_no::int AS "jobNo",
              j.name AS "jobName", cu.name AS "customerName",
              a.starts_at::text AS "startsAt", w.name AS "workerName", a.status,
              GREATEST(0, (CURRENT_DATE - a.ends_at::date))::int AS "ageDays"
         FROM appointments a
         JOIN jobs j ON j.id = a.job_id
         JOIN customers cu ON cu.id = j.customer_id
         LEFT JOIN workers w ON w.id = a.worker_id
        WHERE a.ends_at < now() AND a.status = 'scheduled'
        ORDER BY a.ends_at ASC
        LIMIT 10`,
    );

    // ⛔ Set-based, not one query per job. The WIP report had to have exactly
    // this fixed after it fired 201 queries on a 40-job shop; a dashboard that
    // repeats the mistake would be slowest for the busiest customer.
    // `required_for_completion` lives on the TEMPLATE, so the join is how a
    // form knows whether it blocks completion.
    const jobs = await c.query(
      `SELECT j.id AS "jobId", j.job_no::int AS "jobNo", j.name, cu.name AS "customerName",
              j.status,
              EXISTS (SELECT 1 FROM cost_entries ce WHERE ce.job_id = j.id) AS "hasCosts",
              COALESCE((
                SELECT count(*) FROM job_forms f
                  JOIN form_templates t ON t.id = f.template_id
                 WHERE f.job_id = j.id
                   AND f.status = 'open'
                   AND t.required_for_completion
              ), 0)::int AS "openRequiredForms",
              GREATEST(0, (CURRENT_DATE - j.created_at::date))::int AS "ageDays"
         FROM jobs j
         JOIN customers cu ON cu.id = j.customer_id
        WHERE j.status IN ('scheduled', 'in-progress')
        ORDER BY j.job_no DESC
        LIMIT 200`,
    );

    const intake = await c.query(
      `SELECT id AS "intakeId", name, COALESCE(description, '') AS description,
              created_at::text AS "createdAt",
              GREATEST(0, (CURRENT_DATE - created_at::date))::int AS "ageDays"
         FROM intake_requests
        WHERE status = 'new'
        ORDER BY created_at
        LIMIT 20`,
    );

    // ⛔ REAL totals, counted in SQL, NOT the length of the LIMITed arrays
    // above. Cheap (three indexed counts in one round trip) and the only way
    // the number keeps moving once a backlog passes the cap.
    const totals = await c.query<{ today: number; jobs: number; waiting: number }>(
      `SELECT
         (SELECT count(*) FROM appointments
           WHERE starts_at >= CURRENT_DATE
             AND starts_at < CURRENT_DATE + interval '1 day'
             AND status <> 'canceled')::int AS today,
         (SELECT count(*) FROM jobs
           WHERE status IN ('scheduled', 'in-progress'))::int AS jobs,
         (SELECT count(*) FROM intake_requests WHERE status = 'new')::int AS waiting`,
    );
    const t = totals.rows[0]!;

    return {
      facts: {
        today: today.rows as FieldFacts["today"],
        staleAppointments: stale.rows as FieldFacts["staleAppointments"],
        activeJobs: jobs.rows as FieldFacts["activeJobs"],
        waitingIntake: intake.rows as FieldFacts["waitingIntake"],
      },
      counts: { today: t.today, activeJobs: t.jobs, waiting: t.waiting },
    };
  });
}
