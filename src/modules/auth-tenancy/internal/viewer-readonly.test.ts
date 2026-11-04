import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * "Viewer — look, don't touch" is a PROMISE ON THE TEAM SCREEN. This test is
 * what makes it true.
 *
 * Twelve mutating routes shipped with a department requirement and no role
 * requirement, so a viewer holding the financials wall could import a bank
 * statement, reconcile an account, create vendors and bills, and issue
 * invoices. The structural cause: WRITE_ROLES omits `bookkeeper`, the CPA
 * legitimately reconciles, so rather than lock the CPA out the roles key was
 * dropped entirely. BOOKS_ROLES is the set those routes actually meant.
 *
 * A unit test can't exercise Next route handlers without a server, so this
 * reads the SOURCE and asserts the invariant structurally: every mutating
 * handler must state a role requirement. That is exactly the drift a future
 * route would reintroduce silently.
 */

const API_DIR = join(process.cwd(), "src", "app", "api");

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, acc);
    else if (entry === "route.ts") acc.push(full);
  }
  return acc;
}

/**
 * Routes whose mutating handler legitimately has NO role requirement, each
 * with the reason. An exemption is a decision on the record.
 */
const EXEMPT = new Map<string, string>([
  ["auth/login", "pre-membership: this is how you get a scope at all"],
  ["auth/dev-login", "pre-membership, dev-only"],
  ["auth/signup", "pre-membership: creates the tenant + owner"],
  ["auth/logout", "any authenticated principal may end their own session"],
  ["auth/select-tenant", "membership is re-verified inside selectTenant()"],
  ["webhooks/stripe", "machine principal, HMAC-verified"],
  ["webhooks/stripe/billing", "machine principal, HMAC-verified"],
  ["webhooks/retell", "machine principal, HMAC-verified"],
  ["webhooks/twilio/sms", "machine principal, X-Twilio-Signature over the public URL + params"],
  ["cron/daily", "machine principal, constant-time shared secret"],
  ["public/intake/[slug]", "unauthenticated public form by design"],
  ["public/book/[slug]", "unauthenticated self-booking by design; the shop's own `enabled` switch is the gate, and the slot race is closed with an advisory lock"],
  ["public/portal/[token]", "portal token IS the authentication"],
  ["public/portal/[token]/checkout", "portal token IS the authentication"],
  ["public/portal/[token]/card", "portal token IS the authentication"],
  ["advisor", "redeeming an invite happens before a membership exists"],
  ["account/export", "owner/admin gate lives in the handler + aal2"],
]);

describe("viewer is genuinely read-only", () => {
  const files = routeFiles(API_DIR);

  it("every mutating route states a role requirement", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const rel = relative(API_DIR, file).split(sep).slice(0, -1).join("/");
      if (EXEMPT.has(rel)) continue;
      const mutates = /export const (POST|PATCH|PUT|DELETE)\b/.test(src);
      if (!mutates) continue;
      // A role requirement anywhere in the file: WRITE_ROLES, BOOKS_ROLES, or
      // an explicit roles: [...] literal.
      const statesRole =
        /WRITE_ROLES|BOOKS_ROLES/.test(src) || /roles:\s*\[/.test(src);
      if (!statesRole) offenders.push(rel);
    }
    expect(
      offenders,
      `these mutating routes accept ANY member, including a viewer:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the exemption list has no stale entries", () => {
    const all = new Set(
      files.map((f) => relative(API_DIR, f).split(sep).slice(0, -1).join("/")),
    );
    const stale = [...EXEMPT.keys()].filter((r) => !all.has(r));
    expect(stale, `exempted routes that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });
});
