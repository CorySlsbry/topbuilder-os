import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { deliverBestEffort } from "@/modules/comms";

export class ProspectingError extends HttpError {
  constructor(status: 400 | 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

export const STAGES = ["new", "qualify", "propose", "follow_up", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];

export interface OpportunityRow {
  id: string;
  customerId: string;
  customerName: string;
  title: string;
  stage: Stage;
  valueCents: number;
  nextTask: string;
  nextTaskDue: string | null;
  daysInStage: number;
  createdAt: string;
}

export async function createOpportunity(
  scope: TenantScope,
  input: { customerId: string; title: string; valueCents?: number; propertyId?: string; source?: "manual" | "map" },
): Promise<{ id: string }> {
  if (!input.title.trim()) throw new ProspectingError(422, "title_required");
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO opportunities
         (tenant_id, customer_id, property_id, title, value_cents, source, owner_uid, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
      [
        scope.tenantId, input.customerId, input.propertyId ?? null,
        input.title.trim(), input.valueCents ?? 0, input.source ?? "manual", scope.uid,
      ],
    );
    const id = rows[0]!.id;
    // stage history and the row commit together — days-in-stage math reads
    // ONLY the events, so an opportunity without its first event would be
    // invisible to the aging report
    await c.query(
      `INSERT INTO opportunity_stage_events (tenant_id, opportunity_id, stage, by)
       VALUES ($1, $2, 'new', $3)`,
      [scope.tenantId, id, scope.uid],
    );
    return { id };
  });
}

export async function advanceStage(
  scope: TenantScope,
  id: string,
  stage: Stage,
  lostReason?: string,
): Promise<void> {
  if (!STAGES.includes(stage)) throw new ProspectingError(422, "unknown_stage");
  if (stage === "lost" && !lostReason?.trim()) {
    // the DB CHECK backstops this; the 422 is so the message is human
    throw new ProspectingError(422, "lost_needs_reason");
  }
  await withTenant(scope, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE opportunities
          SET stage = $2, lost_reason = COALESCE($3, lost_reason),
              stage_changed_at = now()
        WHERE id = $1 AND stage NOT IN ('won','lost')`,
      [id, stage, lostReason?.trim() || null],
    );
    if (rowCount === 0) throw new ProspectingError(409, "opportunity_closed_or_missing");
    await c.query(
      `INSERT INTO opportunity_stage_events (tenant_id, opportunity_id, stage, by)
       VALUES ($1, $2, $3, $4)`,
      [scope.tenantId, id, stage, scope.uid],
    );
  });
}

export async function listOpportunities(
  scope: TenantScope,
  filter?: { customerId?: string },
): Promise<OpportunityRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      id: string; customer_id: string; customer_name: string; title: string;
      stage: Stage; value_cents: string; next_task: string;
      next_task_due: string | null; days_in_stage: string; created_at: string;
    }>(
      `SELECT o.id, o.customer_id, cu.name AS customer_name, o.title, o.stage,
              o.value_cents::text, o.next_task, o.next_task_due::text,
              GREATEST(0, EXTRACT(DAY FROM now() - o.stage_changed_at))::int::text AS days_in_stage,
              o.created_at::date::text AS created_at
         FROM opportunities o
         JOIN customers cu ON cu.id = o.customer_id
        WHERE ($1::uuid IS NULL OR o.customer_id = $1)
        ORDER BY o.created_at DESC`,
      [filter?.customerId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      title: r.title,
      stage: r.stage,
      valueCents: Number(r.value_cents),
      nextTask: r.next_task,
      nextTaskDue: r.next_task_due,
      daysInStage: Number(r.days_in_stage),
      createdAt: r.created_at,
    }));
  });
}

// ---------------------------------------------------------------- outreach
/**
 * The sales agent's executor: deliver an approved outreach message to one
 * customer. Runs inside the action gate's transaction — the client carries
 * the approver's uid, so the events row names the human who said yes.
 *
 * Sending also SNOOZES the triggering signal for 30 days: the conversation
 * is now in flight, so tomorrow's run and the "Worth a call this week" list
 * both stop re-raising it. If nothing comes of it, the signal returns on
 * its own when the snooze lapses.
 */
export async function sendOutreachTx(
  c: PoolClient,
  scope: TenantScope,
  input: { customerId: string; signalKey: string; message: string },
): Promise<{ message: string; via: "sms" | "email" | "none" }> {
  if (!input.message.trim()) throw new ProspectingError(422, "message_required");
  const contact = await c.query<{ phone: string | null; email: string | null }>(
    `SELECT phone, email FROM customers WHERE id = $1`,
    [input.customerId],
  );
  if (contact.rows.length === 0) throw new ProspectingError(404, "customer_not_found");
  const t = await c.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [
    scope.tenantId,
  ]);
  const via = await deliverBestEffort(
    contact.rows[0]!,
    `A note from ${t.rows[0]?.name ?? "your service team"}`,
    input.message,
  );
  // Snooze ONLY when something actually went out. via='none' means no
  // transport or no contact info — nothing is "in flight", so hiding the
  // shop's top target for a month would turn a config gap into lost calls.
  // And a standing 'dismissed' is the owner's permanent no: an old card
  // approved later must not quietly resurrect what they killed.
  if (input.signalKey && via !== "none") {
    await c.query(
      `INSERT INTO target_dispositions (tenant_id, customer_id, signal_key, disposition, until, created_by)
       VALUES ($1, $2, $3, 'snoozed', CURRENT_DATE + 30, $4)
       ON CONFLICT (tenant_id, customer_id, signal_key)
       DO UPDATE SET disposition = 'snoozed', until = CURRENT_DATE + 30
             WHERE target_dispositions.disposition <> 'dismissed'`,
      [scope.tenantId, input.customerId, input.signalKey, scope.uid],
    );
  }
  await c.query(
    `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid)
     VALUES ($1, $2, 'customer', $3, $4)`,
    [
      scope.tenantId,
      via === "none" ? "outreach_drafted" : "outreach_sent",
      input.customerId,
      scope.uid,
    ],
  );
  return { message: input.message, via };
}
