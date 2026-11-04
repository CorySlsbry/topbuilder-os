/**
 * The shape every email provider gets normalised into.
 *
 * ⛔ THE INBOX MUST NEVER LEARN THE PROVIDER'S NAME — the same rule the bank
 * feeds follow, for a stronger reason. Which aggregator sits between us and a
 * shop's Gmail is not a technical preference, it is a COMPLIANCE position:
 * Google requires a CASA Tier 2 security assessment, re-passed every 12 months,
 * for the restricted scopes that reading a mailbox needs. The aggregator's
 * value is that its OAuth app already holds that assessment. Ours does not, and
 * buying one before customer #1 would be weeks and real money.
 *
 * That makes the provider a commercial decision that WILL change — the moment
 * volume justifies owning a CASA, moving to our own Google app should be a new
 * file implementing this interface, not a migration. Unipile documents exactly
 * that exit ("switch to your own verified credentials at any time"), and this
 * interface is what makes taking it cheap.
 *
 * ⛔ WHAT WE DELIBERATELY DO NOT MODEL: folders, labels, threads-as-the-
 * provider-sees-them, read/unread state, drafts. This product has its own
 * thread model already (migration 0040, shared with SMS and voicemail), and a
 * shop's inbox is not our system of record — theirs is. We read messages and we
 * send replies. Mirroring a mail client is how this turns into a mail client.
 */

/** Providers this deployment knows how to speak to. */
export type MailProviderKey = "unipile" | "imap";

/**
 * How a mailbox was reached, kept because the SUPPORT ANSWER differs. "Your
 * Google connection expired, reconnect" and "your app password stopped working"
 * are different sentences to a contractor at 6am.
 */
export type MailAccountKind = "google" | "microsoft" | "imap";

/** A connected mailbox, as the provider describes it. */
export interface MailAccount {
  /** The provider's stable id for this connection. */
  externalId: string;
  /** The address itself — what a customer sees in the From line. */
  address: string;
  /** Display name on the account, when the provider gives one. */
  displayName: string | null;
  kind: MailAccountKind;
}

/**
 * One received message, normalised.
 *
 * ⛔ NO HTML BODY. `text` only, deliberately. The shared inbox renders into a
 * page with a nonce CSP, and piping a stranger's HTML into it is the largest
 * XSS surface this product could possibly grow — the sender is by definition
 * unauthenticated and untrusted. Contractors read these on a phone as text
 * anyway. If rich mail is ever wanted it needs a sanitizer and an iframe, and
 * that is a project, not a field.
 */
export interface MailMessage {
  /** The provider's stable id. THE dedupe key — a re-sync must not duplicate. */
  externalId: string;
  accountExternalId: string;
  /** RFC 5322 Message-ID when present: the only id that survives across
   *  providers, and what lets a reply thread correctly if we ever migrate. */
  messageId: string | null;
  /** In-Reply-To / References head, for threading against what we already hold. */
  inReplyTo: string | null;
  fromAddress: string;
  fromName: string | null;
  /** Every recipient we can see, so a reply-all can be offered honestly. */
  to: string[];
  cc: string[];
  subject: string;
  /** Plain text. See the note above on why there is no HTML here. */
  text: string;
  /** ISO 8601. The provider's timestamp, not ours — a message that sat in a
   *  queue for an hour is still from when it was sent. */
  receivedAt: string;
  /** Metadata only. Bodies are fetched on demand; a sync that eagerly pulled
   *  every attachment would move gigabytes of a shop's mail into our bucket
   *  the first time they connect. */
  attachments: { externalId: string; filename: string; mimeType: string; bytes: number }[];
}

/** A reply we are asking the provider to send AS the shop. */
export interface MailSend {
  accountExternalId: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  /** Threads the reply. Without it the customer gets a new conversation and
   *  the shop looks like it lost the plot. */
  inReplyTo?: string | null;
}

export interface MailProvider {
  key: MailProviderKey;
  label: string;
  /**
   * Is this provider configured on THIS deployment? False means no keys.
   *
   * ⛔ FAILS CLOSED. Every caller checks this before doing anything, and an
   * unconfigured provider must be indistinguishable from a missing feature —
   * never a half-connected state that throws at the moment a customer's reply
   * is being sent.
   */
  isConfigured(): boolean;
  /**
   * Begin a connection. Returns a URL to send the human to; the provider hosts
   * the consent screen, which is the entire point — their OAuth app carries the
   * Google assessment, not ours.
   */
  startConnect(opts: { tenantId: string; successUrl: string; failureUrl: string }): Promise<{ url: string }>;
  /** Resolve what actually got connected, after the human comes back. */
  getAccount(externalId: string): Promise<MailAccount>;
  /**
   * Messages received since a time. `since` is a LOOKBACK, not a high-water
   * mark — the same lesson the bank feeds learned: mail servers backdate and
   * deliver late, and a cursor that only moves forward silently drops whatever
   * lands behind it.
   */
  listMessages(accountExternalId: string, since: string): Promise<MailMessage[]>;
  /**
   * Fetch one attachment's bytes, on demand.
   *
   * ⛔ TAKES THE MESSAGE ID TOO, and must. An attachment is addressed as a
   * child of its message — `emails/{messageId}/attachments/{attachmentId}` —
   * so a signature carrying only the attachment id cannot build a valid URL.
   * The first version of this interface omitted it, and the Unipile adapter
   * duly filled BOTH path segments with the attachment id, which would have
   * 404'd on every download the moment a caller existed.
   */
  getAttachment(
    accountExternalId: string,
    messageExternalId: string,
    attachmentExternalId: string,
  ): Promise<Uint8Array>;
  send(msg: MailSend): Promise<{ externalId: string }>;
  /** Stop syncing and forget the mailbox at the provider. Called on disconnect
   *  AND on tenant delete — a mailbox we no longer serve must not stay
   *  connected to someone's Google account. */
  disconnect(accountExternalId: string): Promise<void>;
}

/**
 * The mailbox needs the human to log in again.
 *
 * Distinguished from every other failure because the FIX is different: a
 * reconnect prompt, not a retry. Tokens die for ordinary reasons — a password
 * change, a revoked app, an admin policy — and a shop must be told which.
 */
export class MailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailAuthError";
  }
}

/** Thrown when the provider is not configured on this deployment. */
export class MailNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`${provider} is not configured on this deployment`);
    this.name = "MailNotConfiguredError";
  }
}
