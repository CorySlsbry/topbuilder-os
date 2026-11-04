// comms module — public port.
//
// Outbound email/SMS, key-gated and fail-closed. Two sanctioned senders
// (Cory 2026-08-03): TRANSACTIONAL notifications (reminders, on-my-way,
// receipts, visit-due) send automatically once the shop enables them —
// customers expect those without a human pressing send. RELATIONSHIP
// messages (review asks, payment chasing) still only leave through a
// human-approved action; the gate is the permission.
import "server-only";

export {
  CommsError,
  deliverBestEffort,
  sendEmail,
  sendSms,
  transportsAvailable,
} from "./internal/transport";

// Transactional notifications (auto once enabled) + per-tenant comms
// settings. Relationship messages stay HITL through the CRM agent.
export {
  getCommsSettings,
  notifyCustomer,
  runDailyNotifications,
  updateCommsSettings,
} from "./internal/notify";
export type { CommsSettings, NotifyKind, NotifyResult } from "./internal/notify";

// ─────────────────────────────────────────────────────── the shared inbox
// The other direction. Until this landed the product could talk but never
// listen: no inbound store, no thread, no reply box. One conversation per
// counterparty ADDRESS (their phone or their email), every medium — text,
// call, email, internal note — on the same thread, because from the
// customer's side it is one conversation.
export {
  getMessageMedia,
  getThread,
  InboxError,
  linkThreadCustomer,
  listThreads,
  openThreadForCustomer,
  sendReply,
  unreadCount,
  updateThread,
} from "./internal/inbox";
export type {
  MessageChannel,
  MessageRow,
  SendReplyInput,
  ThreadDetail,
  ThreadRow,
} from "./internal/inbox";

// Inbound routing (no session — a carrier POSTs to a public URL and the
// tenant is resolved from the number that was texted).
export { InboundError, receiveSms, recordInboundCall } from "./internal/inbound";
export type { InboundCall, InboundMedia, InboundResult, InboundSms } from "./internal/inbound";
export { signingString, verifyTwilioSignature } from "./internal/twilio-signature";
export { consentKeyword, formatPhone, normalizeEmail, normalizePhone } from "./internal/contact";

// The polish helper — the ONE model call in this system. Rewrite-only,
// figure-firewalled, and it fails by returning the words you typed.
export { polish, polishAvailable, PolishError } from "./internal/polish";
export type { PolishResult, PolishTone } from "./internal/polish";

// Voicemail -> draft reply. The gate is exported because the SEND path
// enforces it too: a browser disabling a button is not a guarantee.
export {
  checkDraft,
  draftAvailable,
  draftReply,
  DraftError,
  hasUnfilledPlaceholders,
  PLACEHOLDERS,
} from "./internal/draft";
export type { DraftResult } from "./internal/draft";
