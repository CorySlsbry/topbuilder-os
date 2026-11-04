import "server-only";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pool";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { computeOpenSlots, localDate, type OpenSlot } from "./slots";

/** Fallback when a tenant row somehow carries no zone. Matches the column
 *  default in migration 0042 rather than UTC, because UTC is the bug. */
const DEFAULT_TIMEZONE = "America/Phoenix";

export class IntakeError extends HttpError {
  constructor(status: 404 | 409 | 422 | 429, code: string) {
    super(status, code);
  }
}

export interface IntakeInput {
  source: "call" | "web" | "manual";
  externalId: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  description?: string;
  preferredWindow?: "any" | "morning" | "afternoon";
}

export interface IntakeRow {
  id: string;
  source: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  description: string;
  preferredWindow: string;
  status: string;
  jobId: string | null;
  appointmentId: string | null;
  createdAt: string;
}

/**
 * PUBLIC entry (no session): resolve the tenant from its slug via the
 * SECURITY DEFINER lookup, then insert under that tenant's RLS scope.
 * Idempotent per (tenant, externalId) — a retried webhook or double-submit
 * lands exactly one request. Returns null tenant = quiet 404 (no probing).
 */
/**
 * Resolve a tenant from its PUBLIC slug, with no session.
 *
 * Exposed because more than one unauthenticated entry point needs it now: the
 * booking form creates an intake request, and the voice webhook also has to
 * put the call in that shop's inbox. Duplicating the lookup would mean two
 * places deciding what "unknown tenant" means. Returns only an id — the
 * SECURITY DEFINER function it calls exposes nothing else.
 */
export async function publicTenantIdBySlug(slug: string): Promise<string | null> {
  const { rows } = await getPool().query<{ tenant_id: string | null }>(
    "SELECT app.tenant_id_by_slug($1) AS tenant_id",
    [slug],
  );
  return rows[0]?.tenant_id ?? null;
}

export async function publicCreateIntake(
  slug: string,
  input: IntakeInput,
): Promise<{ id: string; duplicate: boolean; tenantId: string }> {
  const pool = getPool();
  const tenantId = await publicTenantIdBySlug(slug);
  if (!tenantId) throw new IntakeError(404, "unknown_tenant");

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const ins = await c.query<{ id: string }>(
      `INSERT INTO intake_requests
         (tenant_id, source, external_id, name, phone, email, address,
          description, preferred_window)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, external_id) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        input.source,
        input.externalId,
        input.name.trim().slice(0, 160),
        (input.phone ?? "").slice(0, 40),
        (input.email ?? "").slice(0, 160),
        (input.address ?? "").slice(0, 240),
        (input.description ?? "").slice(0, 1000),
        input.preferredWindow ?? "any",
      ],
    );
    if (ins.rows.length === 0) {
      const dup = await c.query<{ id: string }>(
        `SELECT id FROM intake_requests WHERE external_id = $1`,
        [input.externalId],
      );
      await c.query("COMMIT");
      return { id: dup.rows[0]!.id, duplicate: true, tenantId };
    }
    await c.query("COMMIT");
    return { id: ins.rows[0]!.id, duplicate: false, tenantId };
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

export async function createIntake(
  scope: TenantScope,
  input: IntakeInput,
): Promise<{ id: string; duplicate: boolean }> {
  return withTenant(scope, async (c) => {
    const ins = await c.query<{ id: string }>(
      `INSERT INTO intake_requests
         (tenant_id, source, external_id, name, phone, email, address,
          description, preferred_window)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, external_id) DO NOTHING
       RETURNING id`,
      [
        scope.tenantId,
        input.source,
        input.externalId,
        input.name.trim(),
        input.phone ?? "",
        input.email ?? "",
        input.address ?? "",
        input.description ?? "",
        input.preferredWindow ?? "any",
      ],
    );
    if (ins.rows.length === 0) {
      const dup = await c.query<{ id: string }>(
        `SELECT id FROM intake_requests WHERE external_id = $1`,
        [input.externalId],
      );
      return { id: dup.rows[0]!.id, duplicate: true };
    }
    return { id: ins.rows[0]!.id, duplicate: false };
  });
}

export async function listIntake(scope: TenantScope, status?: string): Promise<IntakeRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT id, source, name, phone, email, address, description,
              preferred_window AS "preferredWindow", status,
              job_id AS "jobId", appointment_id AS "appointmentId",
              created_at::text AS "createdAt"
         FROM intake_requests
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY created_at DESC LIMIT 100`,
      [status ?? null],
    );
    return rows as IntakeRow[];
  });
}

export async function setIntakeStatus(
  scope: TenantScope,
  intakeId: string,
  status: "declined" | "spam",
): Promise<void> {
  await withTenant(scope, async (c) => {
    const r = await c.query(
      `UPDATE intake_requests SET status = $2 WHERE id = $1 AND status = 'new'`,
      [intakeId, status],
    );
    if (r.rowCount === 0) throw new IntakeError(404, "intake_not_new");
  });
}

// -------------------------------------------------------------- open slots
export async function openSlots(scope: TenantScope, days = 10): Promise<OpenSlot[]> {
  return withTenant(scope, async (c) => {
    // The shop's clock. Everything below — which calendar day an appointment
    // falls on, which half of it, and what "today" even means — is wrong in a
    // different way for every tenant if this is assumed rather than read.
    const tz =
      (
        await c.query<{ timezone: string }>(`SELECT timezone FROM tenants WHERE id = $1`, [
          scope.tenantId,
        ])
      ).rows[0]?.timezone ?? DEFAULT_TIMEZONE;

    const workers = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM workers WHERE active`,
    );
    // Bucket in the SHOP'S zone, not UTC. An 8pm Phoenix appointment is 03:00Z
    // the NEXT day; counting it against the wrong date is how a slot that is
    // actually taken keeps getting offered.
    const booked = await c.query<{ date: string; win: string; n: string }>(
      `SELECT (starts_at AT TIME ZONE $1)::date::text AS date,
              CASE WHEN EXTRACT(hour FROM starts_at AT TIME ZONE $1) < 12
                   THEN 'am' ELSE 'pm' END AS win,
              count(*) AS n
         FROM appointments
        WHERE status = 'scheduled' AND starts_at > now()
        GROUP BY 1, 2`,
      [tz],
    );
    const bookedByWindow = new Map(
      booked.rows.map((r) => [`${r.date}|${r.win}`, Number(r.n)]),
    );
    return computeOpenSlots({
      fromDate: localDate(new Date(), tz),
      days,
      workerCount: Number(workers.rows[0]!.n),
      bookedByWindow,
      timeZone: tz,
    });
  });
}

// ----------------------------------------------------------------- booking
/**
 * Book an intake request (the Receptionist's executor, same-transaction):
 * find-or-create the customer by phone-or-name, create a lead job, schedule
 * the appointment in the chosen window, link everything, mark 'booked'.
 * Undo cancels the appointment and returns the request to 'new'.
 */
export async function bookIntakeTx(
  c: PoolClient,
  scope: TenantScope,
  intakeId: string,
  slot: { startsAt: string; endsAt: string },
): Promise<{ customerId: string; jobId: string; jobNo: number; appointmentId: string }> {
  const { rows } = await c.query<{
    id: string;
    name: string;
    phone: string;
    email: string;
    address: string;
    description: string;
    status: string;
  }>(`SELECT id, name, phone, email, address, description, status
        FROM intake_requests WHERE id = $1 FOR UPDATE`, [intakeId]);
  const req = rows[0];
  if (!req) throw new IntakeError(404, "intake_not_found");
  if (req.status !== "new") throw new IntakeError(409, "intake_not_new");

  // find-or-create customer: phone match first (most reliable), then exact name
  let customerId: string | null = null;
  if (req.phone) {
    const byPhone = await c.query<{ id: string }>(
      `SELECT id FROM customers WHERE phone = $1 LIMIT 1`,
      [req.phone],
    );
    customerId = byPhone.rows[0]?.id ?? null;
  }
  if (!customerId) {
    const byName = await c.query<{ id: string }>(
      `SELECT id FROM customers WHERE lower(name) = lower($1) LIMIT 1`,
      [req.name],
    );
    customerId = byName.rows[0]?.id ?? null;
  }
  if (!customerId) {
    const ins = await c.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, phone, email, address)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [scope.tenantId, req.name, req.phone || null, req.email || null, req.address || null],
    );
    customerId = ins.rows[0]!.id;
  }

  const counter = await c.query<{ value: string }>(
    "SELECT app.next_counter('job_no') AS value",
  );
  const jobNo = Number(counter.rows[0]!.value);
  const job = await c.query<{ id: string }>(
    `INSERT INTO jobs (tenant_id, customer_id, job_no, name, job_type)
     VALUES ($1,$2,$3,$4,'retail') RETURNING id`,
    [
      scope.tenantId,
      customerId,
      jobNo,
      req.description ? req.description.slice(0, 120) : `${req.name} — estimate visit`,
    ],
  );
  const jobId = job.rows[0]!.id;

  const appt = await c.query<{ id: string }>(
    `INSERT INTO appointments (tenant_id, job_id, starts_at, ends_at, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [scope.tenantId, jobId, slot.startsAt, slot.endsAt, `Intake: ${req.description}`.slice(0, 300)],
  );
  await c.query(`UPDATE jobs SET status = 'scheduled' WHERE id = $1`, [jobId]);
  await c.query(
    `UPDATE intake_requests SET status = 'booked', customer_id = $2, job_id = $3,
            appointment_id = $4 WHERE id = $1`,
    [intakeId, customerId, jobId, appt.rows[0]!.id],
  );
  await c.query(
    `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid)
     VALUES ($1, 'job_scheduled', 'job', $2, $3)`,
    [scope.tenantId, jobId, scope.uid],
  );
  return { customerId, jobId, jobNo, appointmentId: appt.rows[0]!.id };
}

/** Undo a booking: cancel the appointment, request returns to 'new'. The
 *  lead job stays (harmless, visible history) but drops back to 'lead'. */
export async function unbookIntakeTx(c: PoolClient, intakeId: string): Promise<void> {
  const { rows } = await c.query<{ appointment_id: string | null; job_id: string | null }>(
    `SELECT appointment_id, job_id FROM intake_requests WHERE id = $1 FOR UPDATE`,
    [intakeId],
  );
  const r = rows[0];
  if (!r) throw new IntakeError(404, "intake_not_found");
  if (r.appointment_id) {
    await c.query(`UPDATE appointments SET status = 'canceled' WHERE id = $1`, [
      r.appointment_id,
    ]);
  }
  if (r.job_id) {
    await c.query(`UPDATE jobs SET status = 'lead' WHERE id = $1 AND status = 'scheduled'`, [
      r.job_id,
    ]);
  }
  await c.query(
    `UPDATE intake_requests SET status = 'new', appointment_id = NULL WHERE id = $1`,
    [intakeId],
  );
}
