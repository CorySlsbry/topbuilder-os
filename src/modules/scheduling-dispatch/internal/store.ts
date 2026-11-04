import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";

export class DispatchError extends HttpError {
  constructor(status: 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

export interface BoardAppointment {
  id: string;
  jobId: string;
  jobNo: number;
  jobName: string;
  startsAt: string;
  endsAt: string;
  status: string;
  workerId: string | null;
  workerName: string | null;
  notes: string | null;
}

export interface Board {
  weekStart: string;
  days: string[]; // 7 ISO dates
  workers: { id: string; name: string }[];
  appointments: BoardAppointment[];
}

export async function getBoard(scope: TenantScope, weekStart: string): Promise<Board> {
  return withTenant(scope, async (c) => {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(`${weekStart}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
    const workers = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM workers WHERE active ORDER BY name`,
    );
    const appts = await c.query(
      `SELECT a.id, a.job_id AS "jobId", j.job_no AS "jobNo", j.name AS "jobName",
              a.starts_at::text AS "startsAt", a.ends_at::text AS "endsAt",
              a.status, a.worker_id AS "workerId", w.name AS "workerName", a.notes
         FROM appointments a
         JOIN jobs j ON j.id = a.job_id
         LEFT JOIN workers w ON w.id = a.worker_id
        WHERE a.starts_at >= $1::date AND a.starts_at < $1::date + interval '7 days'
        ORDER BY a.starts_at`,
      [weekStart],
    );
    return {
      weekStart,
      days,
      workers: workers.rows,
      appointments: (appts.rows as (BoardAppointment & { jobNo: string })[]).map((r) => ({
        ...r,
        jobNo: Number(r.jobNo),
      })),
    };
  });
}

export async function assignAppointment(
  scope: TenantScope,
  appointmentId: string,
  workerId: string | null,
): Promise<void> {
  await withTenant(scope, (c) => assignAppointmentTx(c, appointmentId, workerId));
}

export async function assignAppointmentTx(
  c: PoolClient,
  appointmentId: string,
  workerId: string | null,
): Promise<{ assigned: boolean }> {
  const r = await c.query(
    `UPDATE appointments SET worker_id = $2 WHERE id = $1 AND status = 'scheduled'`,
    [appointmentId, workerId],
  );
  if (r.rowCount === 0) throw new DispatchError(404, "appointment_not_schedulable");
  return { assigned: workerId !== null };
}

export async function setAppointmentStatus(
  scope: TenantScope,
  appointmentId: string,
  status: "done" | "canceled",
): Promise<void> {
  await withTenant(scope, async (c) => {
    const r = await c.query(`UPDATE appointments SET status = $2 WHERE id = $1`, [
      appointmentId,
      status,
    ]);
    if (r.rowCount === 0) throw new DispatchError(404, "appointment_not_found");
  });
}

export interface UnassignedAppt {
  id: string;
  jobNo: number;
  jobName: string;
  day: string;
  startsAt: string;
}

/** Unassigned scheduled appointments in the next N days, with the current
 *  per-worker per-day load the balancer needs. */
export async function unassignedWithLoads(
  scope: TenantScope,
  horizonDays = 14,
): Promise<{
  unassigned: UnassignedAppt[];
  workers: { id: string; name: string }[];
  loadByWorkerDay: Map<string, number>;
}> {
  return withTenant(scope, async (c) => {
    const unassigned = await c.query(
      `SELECT a.id, j.job_no AS "jobNo", j.name AS "jobName",
              a.starts_at::date::text AS day, a.starts_at::text AS "startsAt"
         FROM appointments a JOIN jobs j ON j.id = a.job_id
        WHERE a.worker_id IS NULL AND a.status = 'scheduled'
          AND a.starts_at >= now() - interval '1 day'
          AND a.starts_at < now() + ($1 || ' days')::interval
        ORDER BY a.starts_at`,
      [String(horizonDays)],
    );
    const workers = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM workers WHERE active ORDER BY name`,
    );
    const loads = await c.query<{ worker_id: string; day: string; n: string }>(
      `SELECT worker_id, starts_at::date::text AS day, count(*) AS n
         FROM appointments
        WHERE worker_id IS NOT NULL AND status = 'scheduled'
        GROUP BY worker_id, starts_at::date`,
    );
    const loadByWorkerDay = new Map<string, number>();
    for (const l of loads.rows) {
      loadByWorkerDay.set(`${l.worker_id}|${l.day}`, Number(l.n));
    }
    return {
      unassigned: (unassigned.rows as (UnassignedAppt & { jobNo: string })[]).map((r) => ({
        ...r,
        jobNo: Number(r.jobNo),
      })),
      workers: workers.rows,
      loadByWorkerDay,
    };
  });
}
