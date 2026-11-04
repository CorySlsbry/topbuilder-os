import "server-only";
import {
  MailAuthError,
  MailNotConfiguredError,
  type MailAccountKind,
  type MailMessage,
  type MailProvider,
  type MailSend,
} from "./types";

/**
 * Unipile — the first email provider.
 *
 * ── WHY AN AGGREGATOR AT ALL, AND WHY THIS ONE ───────────────────────────
 * Reading a shop's Gmail needs Google's RESTRICTED scopes, and those require a
 * CASA Tier 2 security assessment that must be re-passed every 12 months. That
 * is the whole decision: it is weeks of calendar time and real recurring money
 * before customer #1, and it is not a thing you can ship around. An aggregator
 * whose own OAuth app already carries that assessment removes it entirely.
 *
 * Unipile over Nylas because Nylas puts its pre-verified shared Google app
 * behind a CONTRACT plan — a sales conversation, not a signup — while Unipile
 * advertises CASA Tier 2 certified credentials on the ordinary product and
 * documents switching to your own verified app later. That exit matters more
 * than the price: the day this shop count justifies owning a CASA, moving is a
 * new file implementing MailProvider, not a migration.
 *
 * ── COST, AND WHY LIGHT DOES NOT GET THIS ────────────────────────────────
 * Roughly EUR 5 per connected mailbox per month with a monthly minimum. That is
 * fine on the $349+ tiers and it is NOT fine on Light: a $99 plan runs about $7
 * of COGS today, and one mailbox would add ~75% to that for a solo who already
 * reads his own email on his phone. Email lands under the `comms` capability,
 * which `CAPABILITY_FLOOR` already fences to `solo` and above — so this costs
 * nothing on the tier that cannot afford it, by a rule that already exists
 * rather than a new special case.
 *
 * ── FAILS CLOSED ─────────────────────────────────────────────────────────
 * No key means `isConfigured()` is false, the connect button never appears, and
 * nothing throws in front of a contractor mid-reply. Same posture as the Teller
 * adapter, for the same reason: a half-configured integration fails at the
 * worst possible moment, which is always while someone is talking to a customer.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

function baseUrl(): string {
  // Unipile issues a per-account subdomain (apiXX.unipile.com) rather than one
  // global host, so this is configuration, not a constant.
  return process.env.UNIPILE_BASE_URL ?? "";
}

function apiKey(): string {
  return process.env.UNIPILE_API_KEY ?? "";
}

interface UnipileAccount {
  id: string;
  type?: string;
  name?: string;
  connection_params?: { mail?: { email?: string; username?: string } };
}

interface UnipileEmail {
  id: string;
  message_id?: string | null;
  in_reply_to?: string | null;
  account_id?: string;
  from_attendee?: { identifier?: string; display_name?: string };
  to_attendees?: { identifier?: string }[];
  cc_attendees?: { identifier?: string }[];
  subject?: string;
  body_plain?: string;
  body?: string;
  date?: string;
  attachments?: { id: string; name?: string; mime?: string; size?: number }[];
}

/**
 * Map the provider's account type onto ours.
 *
 * ⛔ An unrecognised type is `imap`, the LEAST-CAPABLE option, never a guess at
 * google/microsoft. The kind drives the reconnect instructions a shop is shown;
 * telling an IMAP user to "sign in with Google again" sends them somewhere that
 * cannot help them.
 */
export function accountKind(raw: string | undefined): MailAccountKind {
  const t = (raw ?? "").toUpperCase();
  if (t.includes("GOOGLE") || t.includes("GMAIL")) return "google";
  if (t.includes("MICROSOFT") || t.includes("OUTLOOK")) return "microsoft";
  return "imap";
}

/** Addresses out of the provider's attendee shape, empties dropped. */
export function addressesOf(list: { identifier?: string }[] | undefined): string[] {
  return (list ?? []).map((a) => (a.identifier ?? "").trim()).filter(Boolean);
}

/**
 * Build the attachment path. PURE and exported ONLY so it can be tested — the
 * function it was extracted from had no test, and consequently shipped with the
 * attachment id in both path segments. A URL builder with two similar-looking
 * id parameters is exactly the shape that needs an assertion rather than a
 * careful reading.
 */
export function attachmentPath(
  accountExternalId: string,
  messageExternalId: string,
  attachmentExternalId: string,
): string {
  const e = encodeURIComponent;
  return `emails/${e(messageExternalId)}/attachments/${e(attachmentExternalId)}?account_id=${e(accountExternalId)}`;
}

/**
 * Normalise one provider email into our shape. Exported and PURE so the
 * mapping — where every real integration bug lives — is unit-tested without a
 * network.
 */
export function toMailMessage(raw: UnipileEmail, fallbackAccountId: string): MailMessage {
  return {
    externalId: raw.id,
    accountExternalId: raw.account_id ?? fallbackAccountId,
    messageId: raw.message_id ?? null,
    inReplyTo: raw.in_reply_to ?? null,
    fromAddress: (raw.from_attendee?.identifier ?? "").trim(),
    fromName: raw.from_attendee?.display_name?.trim() || null,
    to: addressesOf(raw.to_attendees),
    cc: addressesOf(raw.cc_attendees),
    subject: (raw.subject ?? "").trim(),
    // ⛔ `body_plain` ONLY, never `body`. `body` is HTML from an unauthenticated
    // stranger, and the inbox renders under a nonce CSP into a real page. If a
    // provider gives us no plain part we ship an empty string and the thread
    // shows the subject — a message with no body is a smaller failure than an
    // XSS hole. Rich mail needs a sanitizer and an iframe; that is a project.
    text: (raw.body_plain ?? "").trim(),
    receivedAt: raw.date ?? new Date(0).toISOString(),
    attachments: (raw.attachments ?? []).map((a) => ({
      externalId: a.id,
      filename: a.name ?? "attachment",
      mimeType: a.mime ?? "application/octet-stream",
      bytes: a.size ?? 0,
    })),
  };
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; raw?: boolean } = {},
): Promise<T> {
  if (!unipile.isConfigured()) throw new MailNotConfiguredError("unipile");
  const res = await fetch(`${baseUrl()}/api/v1/${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      "X-API-KEY": apiKey(),
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  // ⛔ 401 from US means OUR key is wrong — a deployment problem nobody can fix
  // by clicking. 401/403 about the ACCOUNT means the shop's mailbox needs
  // reconnecting. Collapsing those two into one error sends a contractor to
  // re-authorise Google over and over while the real fault is a missing secret.
  if (res.status === 401 || res.status === 403) {
    const detail = await res.text().catch(() => "");
    if (/credential|disconnect|reconnect|expired|invalid_grant/i.test(detail)) {
      throw new MailAuthError(`mailbox needs reconnecting: ${detail.slice(0, 160)}`);
    }
    throw new Error(`unipile rejected our API key (${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`unipile ${res.status} on ${path}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  if (init.raw) return (new Uint8Array(await res.arrayBuffer())) as T;
  return (await res.json()) as T;
}

export const unipile: MailProvider = {
  key: "unipile",
  label: "Email (Google, Microsoft, IMAP)",

  isConfigured(): boolean {
    return Boolean(apiKey() && baseUrl());
  },

  async startConnect({ tenantId, successUrl, failureUrl }) {
    // The provider HOSTS the consent screen. That is the point of this whole
    // adapter: the Google app the customer sees is theirs, carrying their CASA
    // assessment, not one we had to get audited.
    const r = await call<{ url: string }>("hosted/accounts/link", {
      body: {
        type: "create",
        providers: ["GOOGLE", "MICROSOFT", "IMAP"],
        api_url: baseUrl(),
        // Round-trips back to us so the callback can tell WHICH tenant
        // connected. Never trusted on its own — the callback re-resolves the
        // tenant from the session, this only routes.
        name: tenantId,
        success_redirect_url: successUrl,
        failure_redirect_url: failureUrl,
        // Short-lived: a connect link is a bearer capability to attach a
        // mailbox, and one left in a chat log a week later should be dead.
        expiresOn: new Date(Date.now() + 15 * 60_000).toISOString(),
      },
    });
    return { url: r.url };
  },

  async getAccount(externalId) {
    const a = await call<UnipileAccount>(`accounts/${encodeURIComponent(externalId)}`);
    const mail = a.connection_params?.mail;
    return {
      externalId: a.id,
      address: (mail?.email ?? mail?.username ?? "").trim(),
      displayName: a.name?.trim() || null,
      kind: accountKind(a.type),
    };
  },

  async listMessages(accountExternalId, since) {
    const q = new URLSearchParams({
      account_id: accountExternalId,
      after: since,
      limit: "100",
    });
    const r = await call<{ items?: UnipileEmail[] }>(`emails?${q}`);
    return (r.items ?? []).map((m) => toMailMessage(m, accountExternalId));
  },

  async getAttachment(accountExternalId, messageExternalId, attachmentExternalId) {
    // The MESSAGE id owns the path; the attachment id identifies the child.
    // These were both the attachment id until the review caught it.
    return call<Uint8Array>(
      attachmentPath(accountExternalId, messageExternalId, attachmentExternalId),
      { raw: true },
    );
  },

  async send(msg: MailSend) {
    const r = await call<{ id?: string; message_id?: string }>("emails", {
      body: {
        account_id: msg.accountExternalId,
        to: msg.to.map((identifier) => ({ identifier })),
        ...(msg.cc?.length ? { cc: msg.cc.map((identifier) => ({ identifier })) } : {}),
        subject: msg.subject,
        body: msg.text,
        ...(msg.inReplyTo ? { reply_to: msg.inReplyTo } : {}),
      },
    });
    return { externalId: r.id ?? r.message_id ?? "" };
  },

  async disconnect(accountExternalId) {
    await call(`accounts/${encodeURIComponent(accountExternalId)}`, { method: "DELETE" });
  },
};
