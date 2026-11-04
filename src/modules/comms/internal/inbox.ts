import "server-only";
import { hasUnfilledPlaceholders } from "@/lib/assist/placeholders";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { sendEmail, sendSms, transportsAvailable } from "./transport";
import { formatPhone, normalizePhone } from "./contact";

/**
 * The shared inbox — read and reply.
 *
 * Everything a shop is texted, called about, or emailed, in one thread per
 * person, with a box to type an answer. This is the screen the office lives in
 * at every competitor we are replacing, and the only reason this system did
 * not have one is that it had never been able to RECEIVE a message.
 *
 * ── Why sending is three steps and not one ────────────────────────────────
 *   1. commit the message as `queued` (own transaction)
 *   2. hand it to the carrier
 *   3. commit `sent` or `failed` + the reason
 *
 * The obvious shape — send, and insert the row if it worked — cannot record a
 * failure, because the failure is the case where you never get to the insert.
 * A shop asking "did that go out?" deserves an answer other than silence, so
 * the row exists before the attempt does. Double-sends are prevented one layer
 * up by the route's idempotency key, not by hiding the write.
 */

export class InboxError extends HttpError {
  constructor(status: 404 | 409 | 422 | 503, code: string) {
    super(status, code);
  }
}

export type MessageChannel = "sms" | "voice" | "email" | "note";

export interface ThreadRow {
  id: string;
  customerId: string | null;
  customerName: string | null;
  contactKind: "phone" | "email";
  contact: string;
  contactDisplay: string;
  contactName: string;
  status: "open" | "closed";
  assignedTo: string;
  unread: number;
  lastMessageAt: string;
  lastInboundAt: string | null;
  /** First line of the most recent message — what the list actually shows. */
  preview: string;
  previewDirection: "inbound" | "outbound" | null;
}

export interface MessageRow {
  id: string;
  direction: "inbound" | "outbound";
  channel: MessageChannel;
  body: string;
  subject: string;
  status: string;
  error: string;
  durationSeconds: number | null;
  recordingUrl: string;
  authorUid: string;
  polished: boolean;
  createdAt: string;
  media: { id: string; contentType: string; bytes: number }[];
}

export interface ThreadDetail extends ThreadRow {
  messages: MessageRow[];
  /** Whether a reply can actually leave the building right now, and why not. */
  reply: { channel: "sms" | "email" | null; blocked: string };
}

// ------------------------------------------------------------------ list
export async function listThreads(
  scope: TenantScope,
  filter: { status?: "open" | "closed" | "all"; mine?: boolean } = {},
): Promise<ThreadRow[]> {
  const status = filter.status ?? "open";
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT co.id,
              co.customer_id      AS "customerId",
              cu.name             AS "customerName",
              co.contact_kind     AS "contactKind",
              co.contact,
              co.contact_name     AS "contactName",
              co.status,
              co.assigned_to      AS "assignedTo",
              co.unread,
              co.last_message_at::text AS "lastMessageAt",
              co.last_inbound_at::text AS "lastInboundAt",
              m.body              AS "preview",
              m.direction         AS "previewDirection"
         FROM conversations co
         LEFT JOIN customers cu ON cu.id = co.customer_id
         -- The newest message per thread. LATERAL keeps this one indexed
         -- lookup per row instead of a sort over the whole message table.
         LEFT JOIN LATERAL (
           SELECT body, direction FROM messages
            WHERE conversation_id = co.id
            ORDER BY created_at DESC LIMIT 1
         ) m ON true
        WHERE ($1 = 'all' OR co.status = $1)
          AND ($2::text IS NULL OR co.assigned_to = $2)
        ORDER BY co.last_message_at DESC
        LIMIT 200`,
      [status, filter.mine ? scope.uid : null],
    );
    return (rows as (ThreadRow & { unread: string | number })[]).map((r) => ({
      ...r,
      unread: Number(r.unread),
      contactDisplay:
        r.contactKind === "phone" ? formatPhone(r.contact) : r.contact,
      preview: (r.preview ?? "").split("\n")[0]!.slice(0, 140),
    }));
  });
}

/** The badge on the nav. One number, one query, no thread bodies loaded. */
export async function unreadCount(scope: TenantScope): Promise<number> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ n: string }>(
      `SELECT COALESCE(sum(unread), 0)::text AS n
         FROM conversations WHERE status = 'open'`,
    );
    return Number(rows[0]?.n ?? 0);
  });
}

// ------------------------------------------------------------------ read
export async function getThread(
  scope: TenantScope,
  id: string,
  opts: { markRead?: boolean } = {},
): Promise<ThreadDetail | null> {
  return withTenant(scope, async (c) => {
    // Opening a thread IS reading it — the office should never have to press a
    // second button to clear a badge they have already dealt with.
    if (opts.markRead) {
      await c.query(`UPDATE conversations SET unread = 0 WHERE id = $1`, [id]);
    }
    const { rows } = await c.query(
      `SELECT co.id, co.customer_id AS "customerId", cu.name AS "customerName",
              co.contact_kind AS "contactKind", co.contact,
              co.contact_name AS "contactName", co.status,
              co.assigned_to AS "assignedTo", co.unread,
              co.last_message_at::text AS "lastMessageAt",
              co.last_inbound_at::text AS "lastInboundAt",
              cu.email AS "customerEmail",
              cu.sms_opt_out AS "smsOptOut", cu.email_opt_out AS "emailOptOut"
         FROM conversations co
         LEFT JOIN customers cu ON cu.id = co.customer_id
        WHERE co.id = $1`,
      [id],
    );
    const t = rows[0] as
      | (ThreadRow & {
          customerEmail: string | null;
          smsOptOut: boolean | null;
          emailOptOut: boolean | null;
        })
      | undefined;
    if (!t) return null;

    const msgs = await c.query(
      `SELECT m.id, m.direction, m.channel, m.body, m.subject, m.status,
              m.error, m.duration_seconds AS "durationSeconds",
              m.recording_url AS "recordingUrl", m.author_uid AS "authorUid",
              m.polished, m.created_at::text AS "createdAt",
              COALESCE(
                (SELECT json_agg(json_build_object(
                          'id', md.id, 'contentType', md.content_type,
                          'bytes', md.bytes) ORDER BY md.created_at)
                   FROM message_media md WHERE md.message_id = m.id),
                '[]'::json) AS media
         FROM messages m
        WHERE m.conversation_id = $1
        ORDER BY m.created_at ASC
        LIMIT 500`,
      [id],
    );

    const settings = await c.query<{ sms_number: string; sms_status: string }>(
      `SELECT sms_number, sms_status FROM comms_settings WHERE tenant_id = $1`,
      [scope.tenantId],
    );
    const cfg = settings.rows[0];
    const avail = transportsAvailable();

    // Tell the office the truth about the reply box BEFORE they type. A
    // "Send" button that silently does nothing is how a customer gets ignored
    // for a day and nobody knows why.
    let channel: "sms" | "email" | null = null;
    let blocked = "";
    if (t.contactKind === "phone") {
      if (t.smsOptOut) blocked = "This customer replied STOP — texts to them are turned off.";
      else if (!avail.sms) blocked = "Texting isn't switched on yet for this shop.";
      else if (cfg?.sms_status !== "active" || !cfg.sms_number)
        blocked = "Your shop's text number is still being registered with the carriers.";
      else channel = "sms";
      // Email is a real fallback when we know who they are.
      if (!channel && t.customerEmail && !t.emailOptOut && avail.email) {
        channel = "email";
        blocked = blocked ? `${blocked} This will go out by email instead.` : "";
      }
    } else {
      if (t.emailOptOut) blocked = "This customer opted out of email.";
      else if (!avail.email) blocked = "Email isn't switched on yet for this shop.";
      else channel = "email";
    }

    return {
      ...t,
      unread: opts.markRead ? 0 : Number(t.unread),
      contactDisplay: t.contactKind === "phone" ? formatPhone(t.contact) : t.contact,
      preview: "",
      previewDirection: null,
      messages: msgs.rows as MessageRow[],
      reply: { channel, blocked },
    };
  });
}

// ----------------------------------------------------------------- reply
export interface SendReplyInput {
  conversationId: string;
  body: string;
  /** 'note' never leaves the building. Anything else picks the live channel. */
  channel?: "auto" | "note";
  subject?: string;
  polished?: boolean;
}

export async function sendReply(
  scope: TenantScope,
  input: SendReplyInput,
): Promise<{ id: string; status: string; channel: MessageChannel; error: string }> {
  const body = input.body.trim();
  if (!body) throw new InboxError(422, "empty_message");
  if (body.length > 4000) throw new InboxError(422, "message_too_long");

  /**
   * ⛔ A draft with blanks still in it never leaves the building.
   *
   * The voicemail drafter fills unknown facts with `[time]`, `[date]` and
   * friends, and the reply box disables its send button while any remain. That
   * is a nicety, not a guarantee: the button is in a browser, and the thing
   * that actually protects a customer from receiving "I can be there [time] on
   * [date]" has to sit on this side of the wire.
   *
   * It is deliberately the exact placeholder strings, not a general "contains
   * brackets" rule — a shop typing "(the part we discussed)" or even
   * "[warehouse]" is writing their own words, and this is not the place to
   * have opinions about them.
   */
  if (hasUnfilledPlaceholders(body)) {
    throw new InboxError(422, "draft_has_blanks");
  }

  // ── 1. commit the intent ────────────────────────────────────────────────
  const prepared = await withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      contact_kind: "phone" | "email";
      contact: string;
      customer_id: string | null;
      customer_email: string | null;
      sms_opt_out: boolean | null;
      email_opt_out: boolean | null;
    }>(
      `SELECT co.contact_kind, co.contact, co.customer_id,
              cu.email AS customer_email, cu.sms_opt_out, cu.email_opt_out
         FROM conversations co
         LEFT JOIN customers cu ON cu.id = co.customer_id
        WHERE co.id = $1
        FOR UPDATE OF co`,
      [input.conversationId],
    );
    const t = rows[0];
    if (!t) throw new InboxError(404, "thread_not_found");

    const cfg = (
      await c.query<{ sms_number: string; sms_status: string }>(
        `SELECT sms_number, sms_status FROM comms_settings WHERE tenant_id = $1`,
        [scope.tenantId],
      )
    ).rows[0];

    const isNote = input.channel === "note";
    let channel: MessageChannel = "note";
    let to = "";
    let via: "sms" | "email" | null = null;

    if (!isNote) {
      const avail = transportsAvailable();
      if (
        t.contact_kind === "phone" &&
        !t.sms_opt_out &&
        avail.sms &&
        cfg?.sms_status === "active" &&
        cfg.sms_number
      ) {
        via = "sms";
        to = t.contact;
        channel = "sms";
      } else if (t.customer_email && !t.email_opt_out && avail.email) {
        via = "email";
        to = t.customer_email;
        channel = "email";
      } else if (t.contact_kind === "email" && !t.email_opt_out && avail.email) {
        via = "email";
        to = t.contact;
        channel = "email";
      } else {
        // Nothing is written and nothing is claimed. The thread screen already
        // told the caller this before they typed (see ThreadDetail.reply), so
        // this is the race, not the surprise — and their draft is still in the
        // box because the request failed rather than "succeeding" silently.
        throw new InboxError(503, "no_delivery_channel");
      }
    }

    const ins = await c.query<{ id: string }>(
      `INSERT INTO messages
         (tenant_id, conversation_id, direction, channel, body, subject,
          status, author_uid, polished)
       VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        scope.tenantId,
        input.conversationId,
        channel,
        body,
        (input.subject ?? "").slice(0, 200),
        isNote ? "logged" : "queued",
        scope.uid,
        input.polished ?? false,
      ],
    );
    await c.query(
      `UPDATE conversations
          SET last_message_at = now(),
              status = 'open',       -- answering re-opens a closed thread
              unread = 0             -- you just read it to answer it
        WHERE id = $1`,
      [input.conversationId],
    );
    return {
      id: ins.rows[0]!.id,
      channel,
      via,
      to,
      smsFrom: cfg?.sms_number ?? "",
      subject: input.subject?.trim() || "Message from your contractor",
    };
  });

  if (!prepared.via) {
    return { id: prepared.id, status: "logged", channel: "note", error: "" };
  }

  // ── 2. hand it to the carrier (outside any transaction) ─────────────────
  let status = "sent";
  let error = "";
  try {
    if (prepared.via === "sms") {
      await sendSms(prepared.to, body, prepared.smsFrom);
    } else {
      await sendEmail(prepared.to, prepared.subject, body);
    }
  } catch (err) {
    status = "failed";
    error = (err as Error).message.slice(0, 280);
  }

  // ── 3. record the outcome ───────────────────────────────────────────────
  await withTenant(scope, async (c) => {
    await c.query(`UPDATE messages SET status = $2, error = $3 WHERE id = $1`, [
      prepared.id,
      status,
      error,
    ]);
  });

  return { id: prepared.id, status, channel: prepared.channel, error };
}

// ---------------------------------------------------------------- update
export async function updateThread(
  scope: TenantScope,
  id: string,
  patch: { status?: "open" | "closed"; assignedTo?: string; markRead?: boolean },
): Promise<void> {
  await withTenant(scope, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE conversations
          SET status      = COALESCE($2, status),
              assigned_to = COALESCE($3, assigned_to),
              unread      = CASE WHEN $4 THEN 0 ELSE unread END
        WHERE id = $1`,
      [id, patch.status ?? null, patch.assignedTo ?? null, patch.markRead ?? false],
    );
    if (rowCount === 0) throw new InboxError(404, "thread_not_found");
  });
}

/**
 * Attach an unknown number to a customer — or mint the customer from the
 * thread. The second case is the common one: a stranger texts, the office
 * decides they are a real prospect, and the thread becomes a record.
 */
export async function linkThreadCustomer(
  scope: TenantScope,
  id: string,
  input: { customerId?: string; newName?: string },
): Promise<{ customerId: string }> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      contact_kind: string;
      contact: string;
      contact_name: string;
    }>(
      `SELECT contact_kind, contact, contact_name FROM conversations
        WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const t = rows[0];
    if (!t) throw new InboxError(404, "thread_not_found");

    let customerId = input.customerId ?? "";
    if (!customerId) {
      const name = (input.newName ?? t.contact_name).trim();
      if (!name) throw new InboxError(422, "name_required");
      const ins = await c.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, name, phone, email)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [
          scope.tenantId,
          name.slice(0, 160),
          t.contact_kind === "phone" ? t.contact : "",
          t.contact_kind === "email" ? t.contact : "",
        ],
      );
      customerId = ins.rows[0]!.id;
    } else {
      const exists = await c.query(`SELECT 1 FROM customers WHERE id = $1`, [customerId]);
      if (exists.rowCount === 0) throw new InboxError(404, "customer_not_found");
    }

    await c.query(`UPDATE conversations SET customer_id = $2 WHERE id = $1`, [
      id,
      customerId,
    ]);
    return { customerId };
  });
}

/** Start (or find) a thread from elsewhere in the app — the "text this
 *  customer" button on a job or a customer record. */
export async function openThreadForCustomer(
  scope: TenantScope,
  customerId: string,
): Promise<{ id: string }> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ name: string; phone: string; email: string }>(
      `SELECT name, phone, email FROM customers WHERE id = $1`,
      [customerId],
    );
    const cu = rows[0];
    if (!cu) throw new InboxError(404, "customer_not_found");
    const phone = normalizePhone(cu.phone);
    const kind = phone ? "phone" : "email";
    const contact = phone || (cu.email ?? "").trim().toLowerCase();
    if (!contact) throw new InboxError(422, "customer_has_no_contact");

    const ins = await c.query<{ id: string }>(
      `INSERT INTO conversations
         (tenant_id, customer_id, contact_kind, contact, contact_name)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, contact_kind, contact)
         DO UPDATE SET customer_id = COALESCE(conversations.customer_id, EXCLUDED.customer_id)
       RETURNING id`,
      [scope.tenantId, customerId, kind, contact, cu.name],
    );
    return { id: ins.rows[0]!.id };
  });
}

// ----------------------------------------------------------------- media
export async function getMessageMedia(
  scope: TenantScope,
  id: string,
): Promise<{ storageKey: string; contentType: string } | null> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ storage_key: string; content_type: string }>(
      `SELECT storage_key, content_type FROM message_media WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    return r ? { storageKey: r.storage_key, contentType: r.content_type } : null;
  });
}
