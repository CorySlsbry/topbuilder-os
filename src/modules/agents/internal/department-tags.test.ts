import { describe, expect, it } from "vitest";
import { KINDS } from "./registry";
import { STANDARD_DEPARTMENTS, isProtectedDepartment } from "@/modules/auth-tenancy";

/**
 * Every department key that TAGS a row must be one that cannot be deleted.
 *
 * ⛔ This looks like bookkeeping and it protects "delete my business".
 *
 * `agent_actions.department_key` is written from the kind's own `requires`, and
 * a RESTRICTIVE policy (migration 0029) hides any row whose key is not in the
 * reader's `app.current_departments`. An owner's grant set expands to every key
 * present in the tenant's `departments` table — so a row tagged with a key that
 * NO LONGER EXISTS there is invisible to everybody, forever.
 *
 * That is not just a lost card. `app.purge_current_tenant()` sweeps and then
 * verifies, and BOTH steps run under RLS: it deletes what it can see and then
 * counts what it can see. An invisible row survives the sweep, passes the
 * verify, and blows up the final `DELETE FROM tenants` with a raw foreign-key
 * error — self-service account deletion, a standing gate requirement and an
 * advertised anti-dark-pattern promise, failing at the worst possible moment.
 *
 * Two things keep that from happening, and this file pins both:
 *   1. only STANDARD department keys ever tag a row, and
 *   2. the standard keys are refused by `deleteDepartment`.
 *
 * A new kind requiring a custom department would break the first. Making one of
 * the three deletable would break the second.
 *
 * It lives in the AGENTS module, not auth-tenancy: agents already depends on
 * auth-tenancy for ScopeRequirements, and the reverse import is a module cycle
 * the boundaries rule refuses — which is how this file found its right home.
 */
describe("department tags stay deletable-proof", () => {
  // Widened to string on purpose: a kind's `requires.departments` is a plain
  // string array at runtime, and the point of this test is to catch a value
  // that is NOT one of the three — which the narrow type would refuse to let
  // us even ask about.
  const standard = new Set<string>(STANDARD_DEPARTMENTS.map((d) => d.key));

  it("every kind's required department is a STANDARD one", () => {
    const offenders: string[] = [];
    for (const [kind, spec] of Object.entries(KINDS)) {
      for (const dept of spec.requires.departments ?? []) {
        if (!standard.has(dept)) offenders.push(`${kind} -> ${dept}`);
      }
    }
    expect(
      offenders,
      "a kind requiring a custom department would tag rows with a key that can be deleted",
    ).toEqual([]);
  });

  it("and every standard department is protected from deletion", () => {
    for (const d of STANDARD_DEPARTMENTS) {
      expect(isProtectedDepartment(d.key), d.key).toBe(true);
    }
  });

  it("a custom key is NOT protected — which is exactly why tags must avoid them", () => {
    // The control: if this ever returned true, the test above would pass
    // vacuously and prove nothing. The cast is the point of the check — the
    // signature only admits the three standard keys, and a real tenant's
    // custom department arrives as a plain runtime string.
    const custom: string = "solar";
    expect(isProtectedDepartment(custom as never)).toBe(false);
  });
});
