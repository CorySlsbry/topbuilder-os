import "server-only";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pool";
import { buildObjectKey, isAllowedUpload, putObject } from "@/lib/storage";
import { HttpError } from "@/lib/http/errors";
import { consentKeyword, normalizePhone } from "./contact";

/**
 * Inbound message routing — the half of communication this product never had.
 *
 * Everything here runs with NO SESSION. A carrier POSTs to a public URL, so
 * the principal is a machine authenticated by a signature, and the tenant is
 * resolved from the number that was texted (app.tenant_id_by_sms_number) or
 * from the slug the voice agent was configured with. That is the same shape as
 * the public booking form: a SECURITY DEFINER lookup returning only an id,
 * then everything else under that tenant's RLS scope.
 *
 * Three properties this file exists to guarantee:
 *
 *   IDEMPOTENT — carriers retry. A redelivered MessageSid must land exactly
 *     one row, or the shop sees the same customer message three times and
 *     stops trusting the screen. The unique index on (tenant_id, external_id)
 *     is the enforcement; ON CONFLICT DO NOTHING is how we notice.
 *
 *   NEVER LOSES A MESSAGE — an unknown number still gets a thread. Requiring a
 *     customer record first would mean dropping every first contact, which is
 *     most of them.
 *
 *   RECORDS CONSENT — "STOP" is a legal instruction, not a message. Twilio
 *     enforces it at the carrier and never tells our database, so a shop could
 *     keep queueing texts, see them accepted, and be wrong. We write the
 *     opt-out on our side from the same keyword.
 */

export class InboundError extends HttpError {
  constructor(status: 404 | 422, code: string) {
    super(status, code);
  }
}

/** Runs `fn` scoped to a tenant with NO user principal — the machine path. */
async function asTenant<T>(
  tenantId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
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

export interface InboundMedia {
  url: string;
  contentType: string;
}

export interface InboundSms {
  /** One of OUR numbers — the tenant selector. */
  to: string;
  /** The customer's number. */
  from: string;
  body: string;
  /** Twilio MessageSid — the dedupe anchor. */
  messageSid: string;
  media?: InboundMedia[];
}

export interface InboundResult {
  tenantId: string;
  conversationId: string;
  messageId: string | null;
  duplicate: boolean;
  consent: "stop" | "start" | "help" | null;
}

/**
 * Thread an inbound message onto its conversation, creating the thread and
 * linking the customer where we can. Shared by SMS and voice so the two
 * cannot drift apart on the part that matters (which thread does this belong
 * to, and who is it from).
 */
async function threadInbound(
  c: PoolClient,
  tenantId: string,
  contact: string,
  fallbackName: string,
): Promise<{ conversationId: string; customerId: string | null }> {
  // Who is this? The normalized-phone index makes this an exact match on the
  // number however the office typed it into the customer record.
  const cust = await c.query<{ id: string; name: string }>(
    `SELECT id, name FROM customers
      WHERE phone <> '' AND app.normalize_phone(phone) = $1
      ORDER BY created_at ASC LIMIT 1`,
    [contact],
  );
  const customerId = cust.rows[0]?.id ?? null;
  const name = cust.rows[0]?.name ?? fallbackName;

  const conv = await c.query<{ id: string }>(
    `INSERT INTO conversations
       (tenant_id, customer_id, contact_kind, contact, contact_name,
        last_message_at, last_inbound_at, unread)
     VALUES ($1,$2,'phone',$3,$4, now(), now(), 1)
     ON CONFLICT (tenant_id, contact_kind, contact) DO UPDATE SET
       -- Never un-link a thread someone linked by hand; only ever fill a gap.
       customer_id     = COALESCE(conversations.customer_id, EXCLUDED.customer_id),
       contact_name    = CASE WHEN conversations.contact_name = ''
                              THEN EXCLUDED.contact_name
                              ELSE conversations.contact_name END,
       last_message_at = now(),
       last_inbound_at = now(),
       unread          = conversations.unread + 1,
       -- A new message re-opens a closed thread. Anything else means an
       -- answered-then-replied-to customer silently disappears.
       status          = 'open'
     RETURNING id`,
    [tenantId, customerId, contact, name.slice(0, 160)],
  );
  return { conversationId: conv.rows[0]!.id, customerId };
}

export async function receiveSms(input: InboundSms): Promise<InboundResult> {
  const from = normalizePhone(input.from);
  if (!from) throw new InboundError(422, "unusable_sender");

  const pool = getPool();
  const t = await pool.query<{ tenant_id: string | null }>(
    "SELECT app.tenant_id_by_sms_number($1) AS tenant_id",
    [input.to],
  );
  const tenantId = t.rows[0]?.tenant_id;
  // Quiet 404: an unknown destination number is either a misconfiguration or
  // someone probing. Either way we say nothing useful about who we host.
  if (!tenantId) throw new InboundError(404, "unknown_number");

  const consent = consentKeyword(input.body);

  const result = await asTenant(tenantId, async (c) => {
    const { conversationId, customerId } = await threadInbound(c, tenantId, from, "");

    const ins = await c.query<{ id: string }>(
      `INSERT INTO messages
         (tenant_id, conversation_id, direction, channel, body, status, external_id)
       VALUES ($1,$2,'inbound','sms',$3,'received',$4)
       ON CONFLICT (tenant_id, external_id) WHERE external_id <> '' DO NOTHING
       RETURNING id`,
      [tenantId, conversationId, input.body.slice(0, 4000), input.messageSid],
    );

    // A redelivery must not also bump the unread counter the upsert above just
    // incremented. Undo it rather than restructuring the thread upsert — the
    // duplicate is the rare path and this keeps the common path one statement.
    if (ins.rowCount === 0) {
      await c.query(
        `UPDATE conversations SET unread = GREATEST(unread - 1, 0) WHERE id = $1`,
        [conversationId],
      );
      return { conversationId, messageId: null, duplicate: true };
    }

    // Consent is recorded against the CUSTOMER, because that is what the rest
    // of the system checks before sending. An unlinked number gets no row to
    // write — Twilio still blocks it at the carrier, and the message itself
    // stays in the thread as the evidence.
    if (consent && customerId) {
      if (consent === "stop") {
        await c.query(`UPDATE customers SET sms_opt_out = true WHERE id = $1`, [customerId]);
      } else if (consent === "start") {
        await c.query(`UPDATE customers SET sms_opt_out = false WHERE id = $1`, [customerId]);
      }
    }

    return { conversationId, messageId: ins.rows[0]!.id, duplicate: false };
  });

  // Media lives outside the transaction: it is N network round trips to
  // Twilio, and holding a database transaction open across them is how a
  // connection pool dies on a busy afternoon.
  if (!result.duplicate && result.messageId && input.media?.length) {
    await storeInboundMedia(tenantId, result.conversationId, result.messageId, input.media);
  }

  return { tenantId, ...result, consent };
}

/**
 * Pull MMS attachments into our own storage.
 *
 * Twilio's media URLs need account credentials and do not live forever, so
 * "just save the URL" produces a photo that works in testing and 404s in three
 * months. Best-effort by design: a message whose photo failed to copy is still
 * a message, and losing the text because an image fetch timed out would be the
 * worse trade.
 */
async function storeInboundMedia(
  tenantId: string,
  conversationId: string,
  messageId: string,
  media: InboundMedia[],
): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const MAX_BYTES = 12 * 1024 * 1024;

  const stored: { key: string; contentType: string; bytes: number }[] = [];
  for (const m of media.slice(0, 10)) {
    if (!isAllowedUpload(m.contentType)) continue;
    try {
      const res = await fetch(m.url, { headers: { Authorization: `Basic ${auth}` } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) continue;
      const key = buildObjectKey(tenantId, ["inbox", conversationId], m.contentType);
      await putObject(key, buf, m.contentType);
      stored.push({ key, contentType: m.contentType, bytes: buf.byteLength });
    } catch (err) {
      console.error("[inbox] media copy failed:", (err as Error).message);
    }
  }
  if (stored.length === 0) return;

  await asTenant(tenantId, async (c) => {
    for (const s of stored) {
      await c.query(
        `INSERT INTO message_media (tenant_id, message_id, storage_key, content_type, bytes)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, messageId, s.key, s.contentType, s.bytes],
      );
    }
  });
}

// ------------------------------------------------------------------ voice
export interface InboundCall {
  tenantId: string;
  /** Retell call_id — the dedupe anchor, same role as MessageSid. */
  callId: string;
  phone: string;
  callerName?: string;
  /** What was said. For a voicemail this IS the message. */
  transcript: string;
  recordingUrl?: string;
  durationSeconds?: number;
  /** A voicemail needs a human; a completed booking conversation does not. */
  voicemail?: boolean;
}

/**
 * Put a phone call in the thread.
 *
 * Until now a call produced one intake row with a one-line description and
 * nothing else — no transcript, no recording, no voicemail, nowhere to reply.
 * A shop that misses a call at 4:55pm had no record that it happened. This
 * makes the call a message like any other, on the same thread as that person's
 * texts, because from the customer's side it is the same conversation.
 */
export async function recordInboundCall(input: InboundCall): Promise<{
  conversationId: string;
  messageId: string | null;
  duplicate: boolean;
}> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new InboundError(422, "unusable_caller");

  return asTenant(input.tenantId, async (c) => {
    const { conversationId } = await threadInbound(
      c,
      input.tenantId,
      phone,
      (input.callerName ?? "").trim(),
    );
    const ins = await c.query<{ id: string }>(
      `INSERT INTO messages
         (tenant_id, conversation_id, direction, channel, body, status,
          external_id, recording_url, duration_seconds, subject)
       VALUES ($1,$2,'inbound','voice',$3,'received',$4,$5,$6,$7)
       ON CONFLICT (tenant_id, external_id) WHERE external_id <> '' DO NOTHING
       RETURNING id`,
      [
        input.tenantId,
        conversationId,
        input.transcript.slice(0, 8000),
        `call:${input.callId}`,
        (input.recordingUrl ?? "").slice(0, 500),
        input.durationSeconds ?? null,
        input.voicemail ? "Voicemail" : "Phone call",
      ],
    );
    if (ins.rowCount === 0) {
      await c.query(
        `UPDATE conversations SET unread = GREATEST(unread - 1, 0) WHERE id = $1`,
        [conversationId],
      );
      return { conversationId, messageId: null, duplicate: true };
    }
    // A handled call is a record, not a task. Only a voicemail — nobody
    // answered, somebody must — leaves the thread unread.
    if (!input.voicemail) {
      await c.query(
        `UPDATE conversations SET unread = GREATEST(unread - 1, 0) WHERE id = $1`,
        [conversationId],
      );
    }
    return { conversationId, messageId: ins.rows[0]!.id, duplicate: false };
  });
}
