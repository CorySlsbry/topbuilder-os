// Contact normalization — pure, deterministic, and DELIBERATELY a mirror of
// app.normalize_phone() in migration 0040.
//
// Two systems have to agree on "is this the same person?": the webhook that
// threads an inbound text, and the SQL that finds the customer whose phone
// column the shop typed by hand. Twilio sends "+16025550134"; the office typed
// "602-555-0134"; the customer's own signature says "(602) 555-0134". If those
// resolve differently the inbox grows three threads for one person and the
// customer link never happens — a failure that looks like flakiness rather
// than a bug, which is the worst kind.
//
// The pair is kept honest by contact.test.ts running the same vectors, and by
// the SQL side being the one used for every JOIN (so a drift shows up as a
// missed match, not as a silently different answer).

/**
 * NANP-centric, because this product sells to US trades shops.
 *
 * 10 digits      → +1XXXXXXXXXX
 * 11 leading '1' → +1XXXXXXXXXX
 * anything else  → '+' + digits, so an international number still threads
 *                  consistently instead of collapsing into one bucket.
 * no digits      → '' (an unusable address; callers treat this as "unknown")
 */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits === "") return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

/** Email threading key: case-insensitive, trimmed. No plus-address folding —
 *  `person1@example.com` really is a different reply-to than `person2@example.com`. */
export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

export type ContactKind = "phone" | "email";

export function normalizeContact(kind: ContactKind, raw: string): string {
  return kind === "phone" ? normalizePhone(raw) : normalizeEmail(raw);
}

/** "+16025550134" → "(602) 555-0134" for display. Anything else passes through. */
export function formatPhone(normalized: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(normalized);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : normalized;
}

/**
 * The carrier-level keywords a recipient can text to control consent.
 *
 * This is not a nicety: under the TCPA, honoring STOP is a legal obligation
 * that sits on the SENDER, and Twilio's own opt-out handling stops the message
 * at the carrier without ever telling our database. So a shop could keep
 * queueing texts to someone who opted out, see them "sent", and be wrong about
 * it. We record consent on our side from the same keywords.
 */
export type ConsentKeyword = "stop" | "start" | "help" | null;

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "yes", "unstop"]);

export function consentKeyword(body: string): ConsentKeyword {
  // Carriers match a single bare keyword, case-insensitively. A sentence that
  // merely CONTAINS "stop" ("don't stop by until 3") is not an opt-out, and
  // treating it as one would silently mute a customer.
  const word = body.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (STOP_WORDS.has(word)) return "stop";
  if (START_WORDS.has(word)) return "start";
  if (word === "help" || word === "info") return "help";
  return null;
}
