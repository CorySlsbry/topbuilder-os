import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STRIPE_ACCOUNT_ID, accountMismatch } from "./stripe-account";

/**
 * The law this file exists to hold: A CREDENTIAL MUST NAME ITS ACCOUNT BEFORE
 * IT IS ALLOWED TO WRITE.
 *
 * This workspace holds two Stripe accounts. The one most tooling reaches for
 * first — the local vault's `STRIPE_SECRET_KEY` — belongs to **Auto Advisor**,
 * a different business. It answers every request happily. It just answers about
 * someone else, so every `os_*` lookup_key comes back MISSING, which is
 * indistinguishable from "the prices were deleted."
 *
 * That has now happened three times:
 *   2026-07-19 — wrong vendor account, two confident false statements retracted.
 *   2026-07-24 — the same Stripe mislabel; the write was refused by hand.
 *   2026-08-15 — reported all four OS prices missing, caught only by checking
 *                the account afterwards. A read, so it was retractable.
 *
 * Three times is not a fluke and a vault note did not stop it — the note
 * existed, and said exactly this, on the day it happened again. So the check
 * lives in code, on the write path, where it cannot be skipped by not being
 * read.
 */

describe("the expected Stripe account", () => {
  it("is a concrete account id, not a placeholder or an env lookup", () => {
    // A guard whose expectation comes from the same environment as the
    // credential guards nothing: swap the key, swap the variable, silence.
    // The expectation is checked in, reviewed, and diffed.
    expect(STRIPE_ACCOUNT_ID).toMatch(/^acct_[A-Za-z0-9]+$/);
  });
});

describe("accountMismatch", () => {
  it("passes the account that actually holds the OS prices", () => {
    expect(accountMismatch(STRIPE_ACCOUNT_ID)).toBeNull();
  });

  it("⛔ names Auto Advisor specifically, because that is the one we hit", () => {
    const problem = accountMismatch("acct_1opNbj0fwyxUHS7g");
    expect(problem).toBeTruthy();
    expect(problem).toContain("Auto Advisor");
    // The error has to say what to do about it, or the next person re-derives
    // the whole story from a mismatched pair of opaque ids.
    expect(problem).toContain("vault");
  });

  it("rejects any other account, even an unfamiliar one", () => {
    expect(accountMismatch("acct_somethingElse")).toContain(STRIPE_ACCOUNT_ID);
  });

  it("⛔ treats a MISSING id as a mismatch, never as a pass", () => {
    // "I could not tell" must not open a write path.
    expect(accountMismatch(undefined)).toBeTruthy();
    expect(accountMismatch(null)).toBeTruthy();
    expect(accountMismatch("")).toBeTruthy();
  });
});

describe("the guard is wired to the write path, not to a call site", () => {
  const src = readFileSync(join(__dirname, "stripe-api.ts"), "utf8");

  it("stripeRequest asserts the account for every non-GET", () => {
    // Structural, because the failure mode is a NINTH call site added later by
    // someone who never read this file. If the guard moves out of the one
    // chokepoint and back onto individual callers, this fails.
    expect(src).toContain('if (method !== "GET") await assertStripeAccount();');
  });

  it("a definite mismatch is fatal and an inconclusive answer is not", () => {
    // The two halves have to stay together: caching a network blip would turn
    // a Stripe outage into a permanent billing outage for the instance, and NOT
    // caching a real mismatch would let every retry write to the wrong books.
    expect(src).toContain("stripe_account_mismatch");
    expect(src).toContain("accountVerification = null");
  });

  it("never logs the key", () => {
    const logged = src.match(/console\.(error|log|warn)\([^)]*\)/g) ?? [];
    for (const line of logged) expect(line).not.toMatch(/\bkey\(\)|STRIPE_SECRET_KEY/);
  });
});
