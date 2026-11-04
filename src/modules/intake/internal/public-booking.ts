import "server-only";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pool";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { computeOpenSlots, localDate, localWindow, type OpenSlot } from "./slots";
import { DEFAULT_WINDOWS, windowCapacity, type WorkWindow } from "./capacity";
import { bookIntakeTx, IntakeError } from "./store";

/**
 * Online self-booking — the public half.
 *
 * Everything here runs with NO SESSION. A stranger opens a URL that contains
 * only the shop's public slug, so the principal is nobody and the tenant is
 * resolved by a SECURITY DEFINER lookup. Same shape as the booking form and
 * the customer portal.
 *
 * ── The one hard problem ─────────────────────────────────────────────────
 * Availability is computed when slots are DISPLAYED and consumed when one is
 * PICKED, and between those two moments anyone else can take it. With staff
 * booking that is a rare annoyance somebody notices. On a public page it is
 * Saturday morning and two strangers, and the shop finds out by driving to one
 * of them.
 *
 * So the booking transaction takes an advisory lock over the exact
 * (tenant, date, window) being claimed and RE-COUNTS capacity inside the lock.
 * Displayed availability is a hint; the count inside the lock is the truth.
 */

/** The synthetic principal a self-booking acts as. Never a real uid — this is
 *  a stranger on the internet, and `events.actor_uid` should say so. */
export const PUBLIC_BOOKER_UID = "book:public";

export interface BookingProfile {
  tenantId: string;
  tenantName: string;
  timezone: string;
  enabled: boolean;
  daysOut: number;
  minLeadHours: number;
  intro: string;
  /** How long a self-booked visit is assumed to take. */
  defaultJobMinutes: number;
  /** The shop's working windows. */
  windows?: WorkWindow[];
}

/**
 * How many people can actually work, given a roster that may not exist yet.
 *
 * A shop with NO worker rows is a solo owner-operator who has not set up a
 * crew — one worker. A shop WITH worker rows that are all inactive is closed
 * — zero. The old `Math.max(1, active)` collapsed those into "always at
 * least one" and promised strangers visits at shut shops.
 */
export function effectiveWorkerCount(active: number, total: number): number {
  if (active > 0) return active;
  return total === 0 ? 1 : 0;
}

/** Public shop profile + booking config, or null for an unknown slug. */
export async function publicBookingProfile(slug: string): Promise<BookingProfile | null> {
  const { rows } = await getPool().query<{
    tenant_id: string;
    tenant_name: string;
    timezone: string;
    enabled: boolean;
    days_out: number;
    min_lead_hours: number;
    intro: string;
  }>("SELECT * FROM app.tenant_booking_profile($1)", [slug]);
  const r = rows[0];
  if (!r) return null;

  // The SECURITY DEFINER profile function predates these columns (0044), and
  // widening its RETURNS TABLE would break every deployed copy mid-migration.
  // Read them alongside instead, defaulting to exactly what 0056 declares, so
  // a shop that has never touched the settings behaves as it always did.
  const cfg = await getPool().query<{
    default_job_minutes: number;
    am_start_hour: number;
    am_end_hour: number;
    pm_start_hour: number;
    pm_end_hour: number;
  }>(
    `SELECT default_job_minutes, am_start_hour, am_end_hour, pm_start_hour, pm_end_hour
       FROM booking_settings WHERE tenant_id = $1`,
    [r.tenant_id],
  );
  const c0 = cfg.rows[0];
  const windows: WorkWindow[] | undefined = c0
    ? [
        { key: "am", startHour: c0.am_start_hour, endHour: c0.am_end_hour },
        { key: "pm", startHour: c0.pm_start_hour, endHour: c0.pm_end_hour },
      ]
    : undefined;

  return {
    defaultJobMinutes: c0?.default_job_minutes ?? 120,
    windows,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    timezone: r.timezone,
    enabled: r.enabled,
    daysOut: r.days_out,
    minLeadHours: r.min_lead_hours,
    intro: r.intro,
  };
}

/** Runs `fn` scoped to a tenant with no user principal — the public path. */
async function asTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

/**
 * The open windows a stranger may pick from.
 *
 * Same engine the Receptionist uses — active workers per half-day minus what
 * is already booked — plus the shop's own lead time, so "we need half a day's
 * notice" is honoured rather than implied.
 */
export async function publicOpenSlots(profile: BookingProfile): Promise<OpenSlot[]> {
  const slots = await asTenant(profile.tenantId, async (c) => {
    // ⛔ TWO COUNTS, BECAUSE ZERO MEANS TWO DIFFERENT THINGS.
    //
    // `Math.max(1, activeWorkers)` used to paper over both: a solo
    // owner-operator with no roster (correct to treat as one worker) and a
    // shop that has deactivated everybody (NOT correct — that shop was
    // promising strangers visits nobody could attend).
    //
    // Counting the roster separately tells them apart. No worker rows at all
    // means the owner is the crew; worker rows that are all inactive means
    // the shop is closed, and the booking page says so instead of booking.
    const workers = await c.query<{ active: string; total: string }>(
      `SELECT count(*) FILTER (WHERE active) AS active, count(*) AS total FROM workers`,
    );
    // ⛔ MINUTES, and the SAME predicate the commit-time re-count uses.
    // This query filtered `starts_at > now()` and the re-count did not, so a
    // window holding a past appointment looked emptier when it was OFFERED
    // than when it was BOOKED — and the stranger who did everything right
    // got "that slot was just taken" for no reason they could see.
    const booked = await c.query<{ date: string; win: string; n: string }>(
      `SELECT (starts_at AT TIME ZONE $1)::date::text AS date,
              CASE WHEN EXTRACT(hour FROM starts_at AT TIME ZONE $1) < 12
                   THEN 'am' ELSE 'pm' END AS win,
              COALESCE(SUM(EXTRACT(EPOCH FROM (ends_at - starts_at)) / 60), 0)::int AS n
         FROM appointments
        WHERE status = 'scheduled'
        GROUP BY 1, 2`,
      [profile.timezone],
    );
    return computeOpenSlots({
      fromDate: localDate(new Date(), profile.timezone),
      days: profile.daysOut,
      workerCount: effectiveWorkerCount(
        Number(workers.rows[0]!.active),
        Number(workers.rows[0]!.total),
      ),
      bookedByWindow: new Map(booked.rows.map((r) => [`${r.date}|${r.win}`, Number(r.n)])),
      // How long a self-booked visit is assumed to take, per shop. A
      // stranger's booking has no job behind it yet, so this is the only
      // honest number available at that moment.
      jobMinutes: profile.defaultJobMinutes,
      windows: profile.windows,
      timeZone: profile.timezone,
    });
  });

  // The shop's notice period. Applied here rather than inside computeOpenSlots
  // so that function stays about capacity and nothing else.
  const earliest = Date.now() + profile.minLeadHours * 3_600_000;
  return slots.filter((s) => Date.parse(s.startsAt) >= earliest);
}

export interface SelfBookInput {
  /** Caller-minted nonce. Makes a double-tap on a flaky phone idempotent. */
  nonce: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  description?: string;
  /** The exact instant the customer chose, from the offered slots. */
  startsAt: string;
  endsAt: string;
}

export interface SelfBookResult {
  jobNo: number;
  startsAt: string;
  duplicate: boolean;
}

/**
 * Claim a slot.
 *
 * The whole function is one transaction, and the order inside it is the
 * point:
 *   1. lock the (tenant, date, window) — everyone else claiming this half-day
 *      now waits;
 *   2. RE-COUNT capacity, because the number the customer was shown is stale
 *      by definition;
 *   3. only then write the request and the appointment.
 */
export async function publicSelfBook(
  profile: BookingProfile,
  input: SelfBookInput,
): Promise<SelfBookResult> {
  if (!profile.enabled) throw new IntakeError(409, "booking_disabled");

  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new IntakeError(422, "invalid_slot");
  }
  // Never trust the client's idea of when it is. A slot in the past, or one
  // inside the shop's notice period, is refused whatever the form posted.
  if (start.getTime() < Date.now() + profile.minLeadHours * 3_600_000) {
    throw new IntakeError(409, "slot_too_soon");
  }

  const date = localDate(start, profile.timezone);
  const win = localWindow(start, profile.timezone);

  return asTenant(profile.tenantId, async (c) => {
    // ── 1. serialize everyone claiming this half-day ────────────────────
    await c.query("SELECT app.lock_slot($1, $2::date, $3)", [profile.tenantId, date, win]);

    // ── 2. is this the SAME person tapping twice? ───────────────────────
    // This has to come BEFORE the capacity check, and the ordering is not
    // cosmetic: with capacity first, a customer who double-taps on a flaky
    // phone gets told "somebody just took that time" — about themselves,
    // because their own first booking consumed the last slot. Caught by the
    // endpoint sweep asserting that a repeated nonce replays.
    const existing = await c.query<{ job_no: number; starts_at: string | null }>(
      `SELECT j.job_no, a.starts_at::text
         FROM intake_requests r
         JOIN jobs j ON j.id = r.job_id
         LEFT JOIN appointments a ON a.id = r.appointment_id
        WHERE r.external_id = $1`,
      [input.nonce],
    );
    const prior = existing.rows[0];
    if (prior) {
      return {
        // Number(), because pg hands a bigint back as a STRING. Without this
        // the replay path returns "2" where the fresh path returns 2, and a
        // caller comparing them concludes it booked twice — which is exactly
        // what the endpoint sweep reported.
        jobNo: Number(prior.job_no),
        startsAt: prior.starts_at ?? start.toISOString(),
        duplicate: true,
      };
    }

    // ── 3. the truth, not the hint ──────────────────────────────────────
    // ⛔ THE SAME ARITHMETIC THE OFFER USED. This block counted APPOINTMENTS
    // while the offer counted capacity, and counted them without the offer's
    // date filter — two divergences on the two sides of one promise. Both
    // sides now measure minutes over the same rows, through the same pure
    // function, so a slot that was offered can be booked.
    const cap = await c.query<{ active: string; total: string }>(
      `SELECT count(*) FILTER (WHERE active) AS active, count(*) AS total FROM workers`,
    );
    const used = await c.query<{ n: string }>(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ends_at - starts_at)) / 60), 0)::int AS n
         FROM appointments
        WHERE status = 'scheduled'
          AND (starts_at AT TIME ZONE $1)::date = $2::date
          AND (CASE WHEN EXTRACT(hour FROM starts_at AT TIME ZONE $1) < 12
                    THEN 'am' ELSE 'pm' END) = $3`,
      [profile.timezone, date, win],
    );
    const window = (profile.windows ?? DEFAULT_WINDOWS).find((w) => w.key === win)!;
    const room = windowCapacity({
      workerCount: effectiveWorkerCount(
        Number(cap.rows[0]!.active),
        Number(cap.rows[0]!.total),
      ),
      windowHours: window.endHour - window.startHour,
      bookedMinutes: Number(used.rows[0]!.n),
      jobMinutes: profile.defaultJobMinutes,
    });
    if (!room.fits) {
      throw new IntakeError(409, "slot_taken");
    }

    // ── 3. record the request, then book it ─────────────────────────────
    const ins = await c.query<{ id: string }>(
      `INSERT INTO intake_requests
         (tenant_id, source, external_id, name, phone, email, address, description,
          preferred_window, requested_starts_at, requested_ends_at)
       VALUES ($1,'web',$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, external_id) DO NOTHING
       RETURNING id`,
      [
        profile.tenantId,
        input.nonce,
        input.name.trim().slice(0, 160),
        (input.phone ?? "").slice(0, 40),
        (input.email ?? "").slice(0, 160),
        (input.address ?? "").slice(0, 240),
        (input.description ?? "").slice(0, 1000),
        win === "am" ? "morning" : "afternoon",
        start.toISOString(),
        end.toISOString(),
      ],
    );

    if (ins.rowCount === 0) {
      // The pre-check above catches the ordinary double-tap, because the
      // advisory lock serialises everyone claiming the same half-day. This
      // covers the case it cannot: the same nonce sent at two DIFFERENT
      // slots, which takes two different locks and so never serialises.
      // A row exists but has not been booked yet — say so plainly rather than
      // booking the same person twice.
      throw new IntakeError(409, "already_submitted");
    }

    const booked = await bookIntakeTx(
      c,
      { uid: PUBLIC_BOOKER_UID, tenantId: profile.tenantId } as TenantScope,
      ins.rows[0]!.id,
      { startsAt: start.toISOString(), endsAt: end.toISOString() },
    );
    return { jobNo: booked.jobNo, startsAt: start.toISOString(), duplicate: false };
  });
}

// ────────────────────────────────────────────────── owner-facing settings
export interface BookingSettings {
  enabled: boolean;
  daysOut: number;
  minLeadHours: number;
  intro: string;
  /** The shop's own booking URL, so the owner can copy it onto their site. */
  slug: string;
  timezone: string;
}

export async function getBookingSettings(scope: TenantScope): Promise<BookingSettings> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      enabled: boolean | null;
      days_out: number | null;
      min_lead_hours: number | null;
      intro: string | null;
      slug: string;
      timezone: string;
    }>(
      `SELECT b.enabled, b.days_out, b.min_lead_hours, b.intro, t.slug, t.timezone
         FROM tenants t LEFT JOIN booking_settings b ON b.tenant_id = t.id
        WHERE t.id = $1`,
      [scope.tenantId],
    );
    const r = rows[0];
    return {
      enabled: r?.enabled ?? false,
      daysOut: r?.days_out ?? 14,
      minLeadHours: r?.min_lead_hours ?? 12,
      intro: r?.intro ?? "",
      slug: r?.slug ?? "",
      timezone: r?.timezone ?? "America/Phoenix",
    };
  });
}

export async function updateBookingSettings(
  scope: TenantScope,
  patch: Partial<Pick<BookingSettings, "enabled" | "daysOut" | "minLeadHours" | "intro">> & {
    timezone?: string;
  },
): Promise<BookingSettings> {
  await withTenant(scope, async (c) => {
    await c.query(
      `INSERT INTO booking_settings
         (tenant_id, enabled, days_out, min_lead_hours, intro, updated_by)
       VALUES ($1, COALESCE($2,false), COALESCE($3,14), COALESCE($4,12), COALESCE($5,''), $6)
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled        = COALESCE($2, booking_settings.enabled),
         days_out       = COALESCE($3, booking_settings.days_out),
         min_lead_hours = COALESCE($4, booking_settings.min_lead_hours),
         intro          = COALESCE($5, booking_settings.intro),
         updated_by     = $6,
         updated_at     = now()`,
      [
        scope.tenantId,
        patch.enabled ?? null,
        patch.daysOut ?? null,
        patch.minLeadHours ?? null,
        patch.intro ?? null,
        scope.uid,
      ],
    );
    // The shop's clock lives on `tenants` (a directory table the public
    // lookup can read); the trigger there rejects an invalid zone.
    if (patch.timezone) {
      await c.query(`UPDATE tenants SET timezone = $2 WHERE id = $1`, [
        scope.tenantId,
        patch.timezone,
      ]);
    }
  });
  return getBookingSettings(scope);
}
