import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { sendEmail, sendSms, transportsAvailable } from "./transport";

/**
 * Transactional customer notifications (Cory 2026-08-03): appointment
 * reminders, "tech on the way", payment receipts, membership visit-due —
 * sent AUTOMATICALLY once the shop enables them. Relationship messages
 * (review asks, payment chasing) stay human-approved through the CRM agent;
 * nothing here touches those.
 *
 * Channel policy, per the per-tenant-number decision:
 *   SMS  — only when the tenant's own number is REGISTERED ('active') and
 *          the customer hasn't opted out. Sent from the tenant's number.
 *   email — the fallback while A2P registration is pending, and the channel
 *          of record when the customer has no phone.
 *   suppressed — opted out or unreachable; logged, never guessed around.
 *
 * Every attempt lands in notification_log whatever happened: support answers
 * "did the reminder go out?" from that table, and the opt-out rows are the
 * TCPA evidence.
 *
 * Failures are RETURNED, never thrown into the caller's flow — a Twilio
 * outage must not fail the appointment that triggered the reminder.
 */

export type NotifyKind = "reminder" | "on_my_way" | "receipt" | "visit_due";

const TOGGLE: Record<NotifyKind, string> = {
  reminder: "reminder_enabled",
  on_my_way: "on_my_way_enabled",
  receipt: "receipt_enabled",
  visit_due: "visit_due_enabled",
};

export interface NotifyResult {
  status: "sent" | "fallback" | "suppressed" | "failed" | "disabled";
  channel: "sms" | "email" | null;
}

export async function notifyCustomer(
  scope: TenantScope,
  input: {
    customerId: string;
    kind: NotifyKind;
    subject: string;
    text: string;
    /** Dedupe anchor (appointment id, visit id): stored in the log row so a
     *  daily sweep can ask "already sent for THIS thing?" in one query. */
    ref?: string;
  },
): Promise<NotifyResult> {
  return withTenant(scope, async (c) => {
    const settings = await c.query<{
      sms_number: string;
      sms_status: string;
      enabled: boolean;
    }>(
      `SELECT sms_number, sms_status, ${TOGGLE[input.kind]} AS enabled
         FROM comms_settings WHERE tenant_id = $1`,
      [scope.tenantId],
    );
    const cfg = settings.rows[0];
    // No settings row yet = defaults (all four default true in the schema),
    // but no tenant number either — email fallback territory.
    const enabled = cfg?.enabled ?? true;
    if (!enabled) return { status: "disabled" as const, channel: null };

    const cust = await c.query<{
      name: string;
      phone: string | null;
      email: string | null;
      sms_opt_out: boolean;
      email_opt_out: boolean;
    }>(
      `SELECT name, phone, email, sms_opt_out, email_opt_out
         FROM customers WHERE id = $1`,
      [input.customerId],
    );
    const cu = cust.rows[0];
    if (!cu) return { status: "suppressed" as const, channel: null };

    const log = async (
      status: "sent" | "failed" | "suppressed" | "fallback",
      channel: "sms" | "email",
      recipient: string,
      detail = "",
    ) => {
      // Success rows carry the dedupe ref; failure rows carry the error.
      if (!detail && input.ref) detail = input.ref;
      await c.query(
        `INSERT INTO notification_log
           (tenant_id, customer_id, kind, channel, recipient, body, status, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          scope.tenantId,
          input.customerId,
          input.kind,
          channel,
          recipient,
          input.text,
          status,
          detail.slice(0, 300),
        ],
      );
    };

    const t = transportsAvailable();
    const smsReady =
      t.sms && cfg?.sms_status === "active" && !!cfg.sms_number && !!cu.phone && !cu.sms_opt_out;

    if (smsReady) {
      try {
        await sendSms(cu.phone!, input.text, cfg!.sms_number);
        await log("sent", "sms", cu.phone!);
        return { status: "sent" as const, channel: "sms" as const };
      } catch (err) {
        await log("failed", "sms", cu.phone!, (err as Error).message);
        // fall through to email — a carrier hiccup shouldn't lose the message
      }
    }

    if (t.email && cu.email && !cu.email_opt_out) {
      try {
        await sendEmail(cu.email, input.subject, input.text);
        const status = smsReady ? ("sent" as const) : ("fallback" as const);
        await log(status === "sent" ? "sent" : "fallback", "email", cu.email);
        return { status, channel: "email" as const };
      } catch (err) {
        await log("failed", "email", cu.email, (err as Error).message);
        return { status: "failed" as const, channel: "email" as const };
      }
    }

    await log("suppressed", cu.phone ? "sms" : "email", cu.phone ?? cu.email ?? "none",
      cu.sms_opt_out || cu.email_opt_out ? "opted out" : "no reachable contact");
    return { status: "suppressed" as const, channel: null };
  });
}

// ------------------------------------------------------- comms settings
export interface CommsSettings {
  smsNumber: string;
  smsStatus: "none" | "pending_a2p" | "active";
  reminderEnabled: boolean;
  onMyWayEnabled: boolean;
  receiptEnabled: boolean;
  visitDueEnabled: boolean;
  googleReviewUrl: string;
}

export async function getCommsSettings(scope: TenantScope): Promise<CommsSettings> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT sms_number AS "smsNumber", sms_status AS "smsStatus",
              reminder_enabled AS "reminderEnabled", on_my_way_enabled AS "onMyWayEnabled",
              receipt_enabled AS "receiptEnabled", visit_due_enabled AS "visitDueEnabled",
              google_review_url AS "googleReviewUrl"
         FROM comms_settings WHERE tenant_id = $1`,
      [scope.tenantId],
    );
    return (
      (rows[0] as CommsSettings | undefined) ?? {
        smsNumber: "",
        smsStatus: "none",
        reminderEnabled: true,
        onMyWayEnabled: true,
        receiptEnabled: true,
        visitDueEnabled: true,
        googleReviewUrl: "",
      }
    );
  });
}

export async function updateCommsSettings(
  scope: TenantScope,
  patch: Partial<CommsSettings>,
): Promise<void> {
  await withTenant(scope, async (c) => {
    await c.query(
      `INSERT INTO comms_settings
         (tenant_id, sms_number, sms_status, reminder_enabled, on_my_way_enabled,
          receipt_enabled, visit_due_enabled, google_review_url)
       VALUES ($1, COALESCE($2,''), COALESCE($3,'none'), COALESCE($4,true),
               COALESCE($5,true), COALESCE($6,true), COALESCE($7,true), COALESCE($8,''))
       ON CONFLICT (tenant_id) DO UPDATE SET
         sms_number        = COALESCE($2, comms_settings.sms_number),
         sms_status        = COALESCE($3, comms_settings.sms_status),
         reminder_enabled  = COALESCE($4, comms_settings.reminder_enabled),
         on_my_way_enabled = COALESCE($5, comms_settings.on_my_way_enabled),
         receipt_enabled   = COALESCE($6, comms_settings.receipt_enabled),
         visit_due_enabled = COALESCE($7, comms_settings.visit_due_enabled),
         google_review_url = COALESCE($8, comms_settings.google_review_url),
         updated_at = now()`,
      [
        scope.tenantId,
        patch.smsNumber ?? null,
        patch.smsStatus ?? null,
        patch.reminderEnabled ?? null,
        patch.onMyWayEnabled ?? null,
        patch.receiptEnabled ?? null,
        patch.visitDueEnabled ?? null,
        patch.googleReviewUrl ?? null,
      ],
    );
  });
}

// --------------------------------------------------------- daily sweep
/**
 * The tenant-scoped notification pass the daily cron runs: appointment
 * reminders for tomorrow, and visit-due nudges for agreement visits coming
 * due this month that nobody has booked. Dedupe is by notification_log — one
 * reminder per appointment, one nudge per visit per 30 days.
 */
export async function runDailyNotifications(
  scope: TenantScope,
  shopName: string,
): Promise<{ reminders: number; visitNudges: number }> {
  let reminders = 0;
  let visitNudges = 0;

  const appts = await withTenant(scope, (c) =>
    c
      .query<{ id: string; customer_id: string; starts_at: string; job_name: string }>(
        `SELECT a.id, j.customer_id, a.starts_at::text, j.name AS job_name
           FROM appointments a JOIN jobs j ON j.id = a.job_id
          WHERE a.starts_at::date = CURRENT_DATE + 1
            AND NOT EXISTS (
              SELECT 1 FROM notification_log nl
               WHERE nl.kind = 'reminder' AND nl.detail = a.id::text
                 AND nl.status IN ('sent','fallback'))`,
      )
      .then((r) => r.rows),
  );
  for (const a of appts) {
    const when = new Date(a.starts_at).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    const res = await notifyCustomer(scope, {
      customerId: a.customer_id,
      kind: "reminder",
      subject: `Reminder: ${shopName} tomorrow`,
      text: `${shopName}: reminder — we're scheduled for "${a.job_name}" tomorrow around ${when}. Reply STOP to opt out.`,
      ref: a.id,
    });
    if (res.status === "sent" || res.status === "fallback") reminders++;
  }

  const visits = await withTenant(scope, (c) =>
    c
      .query<{ id: string; customer_id: string; plan_name: string }>(
        `SELECT v.id, a.customer_id, p.name AS plan_name
           FROM agreement_visits v
           JOIN agreements a ON a.id = v.agreement_id
           JOIN membership_plans p ON p.id = a.plan_id
          WHERE v.status = 'due' AND a.status = 'active'
            AND v.due_on <= CURRENT_DATE + 30
            AND NOT EXISTS (
              SELECT 1 FROM notification_log nl
               WHERE nl.kind = 'visit_due' AND nl.detail = v.id::text
                 AND nl.created_at > now() - interval '30 days'
                 AND nl.status IN ('sent','fallback'))`,
      )
      .then((r) => r.rows),
  );
  for (const v of visits) {
    const res = await notifyCustomer(scope, {
      customerId: v.customer_id,
      kind: "visit_due",
      subject: `${shopName}: time to schedule your tune-up`,
      text: `${shopName}: your ${v.plan_name} tune-up is coming due — reply or call us and we'll get you on the schedule. Reply STOP to opt out.`,
      ref: v.id,
    });
    if (res.status === "sent" || res.status === "fallback") visitNudges++;
  }

  return { reminders, visitNudges };
}
