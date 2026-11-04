// Which Stripe account is this key allowed to touch?
//
// PURE — no I/O, no server-only marker — so the rule can be tested in
// milliseconds without a network. The fetching lives in stripe-api.ts; only
// the expectation and the comparison live here.
//
// ⛔ WHY THIS FILE EXISTS. A credential is an identity, not a string. This
// workspace has two Stripe accounts, and the one most tools reach for first
// (the local vault's STRIPE_SECRET_KEY) belongs to a DIFFERENT BUSINESS —
// "Auto Advisor", acct_1opNbj0fwyxUHS7g. Point any Top Builder question at it
// and every `os_*` lookup_key comes back MISSING, which reads exactly like
// "someone deleted the prices." That has now happened three times across this
// workspace (2026-07-19, 2026-07-24, 2026-08-15), twice costing real time.
//
// Reading the wrong account gives a wrong answer you can retract. WRITING to
// it leaves real products, customers and charges in someone else's books —
// under someone else's tax ID. So the comparison is not advice, it is a gate:
// stripe-api.ts runs it before every non-GET request, and the preflight script
// runs it before it is allowed to create anything.

/**
 * Top Builder AI's Stripe account. **Same id in test and live** — Stripe scopes
 * modes inside one account — which is what makes a single constant sufficient
 * and is why a test-mode key cannot be mistaken for a different business.
 *
 * Verified 2026-08-15 against both `tbai-stripe-secret-key-live` and
 * `tbai-stripe-secret-key-test`; it is the account holding os_solo_349,
 * os_crew_499 and os_shop_999.
 */
export const STRIPE_ACCOUNT_ID = "acct_1Tck6ws7hh8ngbFG";

/** Accounts we have actually been burned by, named so the error can say so. */
const KNOWN_WRONG: Record<string, string> = {
  acct_1opNbj0fwyxUHS7g: "Auto Advisor (the local vault's STRIPE_SECRET_KEY)",
};

/**
 * Does the account that answered match the one we expect?
 *
 * Returns `null` when it matches, or a human-readable reason when it does not.
 *
 * ⛔ An ABSENT id is a mismatch, not a pass. Stripe always returns `id` on
 * `GET /v1/account`, so a missing one means we are not looking at what we think
 * we are looking at — and "I could not tell" must never open a write path. The
 * distinction that matters is elsewhere: a request that never completed is
 * inconclusive and handled by the caller; a response we CAN read and that
 * disagrees is final.
 */
export function accountMismatch(actual: string | null | undefined): string | null {
  if (!actual) return "Stripe returned no account id — refusing to treat that as a match";
  if (actual === STRIPE_ACCOUNT_ID) return null;
  const known = KNOWN_WRONG[actual];
  return known
    ? `this key belongs to ${known} — expected Top Builder AI ${STRIPE_ACCOUNT_ID}, got ${actual}`
    : `expected Top Builder AI ${STRIPE_ACCOUNT_ID}, got ${actual}`;
}
