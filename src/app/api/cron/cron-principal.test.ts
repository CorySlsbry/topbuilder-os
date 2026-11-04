import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The law this file exists to hold: THE NIGHTLY RUN ACTS UNDER ONE PRINCIPAL,
 * AND THAT PRINCIPAL CARRIES ITS DEPARTMENTS.
 *
 * `withTenant` sets `app.current_departments` from `scope.departments`. A scope
 * without them sets it to the empty string, so every RESTRICTIVE department
 * policy evaluates FALSE and the read fails CLOSED — returning zero rows rather
 * than an error. That is the dangerous half: a wall that denies a legitimate
 * machine principal looks exactly like a shop that owns nothing.
 *
 * It has cost this codebase three separate outages, all the same shape:
 *   - the agents proposed nothing for days (`role_forbidden`), which read as
 *     "no work to do" — fixed at the agents' call site only;
 *   - `syncFeeds` read ZERO bank connections every morning and reported
 *     `feedsSynced: 0`, indistinguishable from "no feed configured";
 *   - `chargeSavedCard` found no card, threw 404 rather than a 402, and every
 *     membership renewal was counted `declined` while its invoice and revenue
 *     posting had already committed.
 *
 * The first was fixed in place and never back-applied to its two siblings,
 * because the route carried TWO scopes for one tenant. A structural test is the
 * right guard here: the failure is invisible at runtime by construction, so
 * only the source can be asserted. Same mould as fenced-routes.test.ts.
 */

const SRC = readFileSync(join(__dirname, "daily", "route.ts"), "utf8");

describe("the cron's machine principal", () => {
  it("⛔ builds exactly ONE scope per tenant, from cronPrincipal", () => {
    // Two scopes for one tenant is the defect itself: whichever one a new call
    // site happens to reach decides whether it can see anything.
    const built = SRC.match(/await cronPrincipal\(/g) ?? [];
    expect(built).toHaveLength(1);
  });

  it("⛔ never reintroduces a bare { uid, tenantId } scope in the loop", () => {
    // The exact literal that caused it: `{ uid: "cron:daily", tenantId: t.id }`.
    // Inside cronPrincipal a bare scope is legitimate and necessary — it is how
    // the departments themselves are bootstrapped — so this asserts the shape
    // does not appear in the tenant LOOP.
    const loop = SRC.slice(SRC.indexOf("for (const t of tenants.rows)"));
    expect(loop).not.toMatch(/\{\s*uid:\s*["']cron:daily["']\s*,\s*tenantId:/);
  });

  it("carries role, departments and aal — the three things a wall reads", () => {
    const fn = SRC.slice(SRC.indexOf("async function cronPrincipal"));
    expect(fn).toContain("departments");
    expect(fn).toContain('role: "owner"');
    expect(fn).toContain('aal: "aal2"');
  });

  it("reads departments from the tenant's own directory, not a hardcoded list", () => {
    // A shop with custom departments (install crews, service, warehouse) must
    // get those too — hardcoding the three standard keys would silently wall
    // the machine principal out of anything a shop added itself.
    const fn = SRC.slice(SRC.indexOf("async function cronPrincipal"));
    expect(fn).toMatch(/SELECT key FROM departments/);
  });

  it("⛔ every step in the loop uses that one scope", () => {
    // The three consumers that were crippled. If a future step is added with
    // its own hand-rolled scope, the one-scope assertion above fails first —
    // this pins that today's steps are actually wired to it.
    const loop = SRC.slice(SRC.indexOf("for (const t of tenants.rows)"));
    for (const call of ["syncFeeds(scope)", "runAgents(scope)", "rolloverDue(scope"]) {
      expect(loop).toContain(call);
    }
  });
});
