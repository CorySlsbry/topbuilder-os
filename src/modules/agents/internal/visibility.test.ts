import { describe, expect, it } from "vitest";
import { checkScope } from "@/modules/auth-tenancy";
import { KINDS } from "./registry";
import { canSeeAgent, canSeeKind, type ActorScope } from "./visibility";

/**
 * These cover the leak the security review found: /api/agents/overview handed
 * every action PAYLOAD — raw bank lines, vendor amounts, per-worker burdened
 * pay — to any member of the tenant, including a `viewer` seat handed to a
 * subcontractor.
 */

function actor(
  role: ActorScope["role"],
  departments: string[],
  aal: "aal1" | "aal2" = "aal1",
): ActorScope {
  return { uid: "u1", tenantId: "t1", role, departments, aal };
}

const check = (s: ActorScope) => (req: Parameters<typeof checkScope>[2]) =>
  checkScope(s, s.aal, req);

describe("agent surface visibility", () => {
  it("hides financial cards from a viewer with no walls", () => {
    const c = check(actor("viewer", []));
    expect(canSeeKind(c, "bank.categorize")).toBe(false);
    expect(canSeeKind(c, "ap.billDraft")).toBe(false);
    expect(canSeeKind(c, "inventory.reorder")).toBe(false);
  });

  it("hides the workforce card — it carries a worker's burdened pay", () => {
    // /api/workforce/workers already refuses this reader; the card must too.
    expect(canSeeKind(check(actor("staff", ["field"])), "time.postWeek")).toBe(false);
    expect(canSeeKind(check(actor("staff", ["financials"])), "time.postWeek")).toBe(false);
  });

  it("still shows field cards to field staff", () => {
    const c = check(actor("staff", ["field"]));
    expect(canSeeKind(c, "dispatch.assign")).toBe(true);
    expect(canSeeKind(c, "intake.book")).toBe(true);
  });

  it("shows financial cards to a bookkeeper holding the financials wall", () => {
    // This is the CPA seat that redeem_advisor_invite mints (migration 0021).
    const c = check(actor("bookkeeper", ["financials"]));
    expect(canSeeKind(c, "bank.categorize")).toBe(true);
  });

  it("shows everything to an owner", () => {
    // resolveScope expands owner/admin to every real department key, so the
    // owner arrives holding them rather than via a wildcard.
    const c = check(actor("owner", ["field", "financials", "hr"]));
    for (const kind of Object.keys(KINDS)) expect(canSeeKind(c, kind)).toBe(true);
  });

  it("fails CLOSED on an unknown kind rather than leaking the payload", () => {
    expect(canSeeKind(check(actor("owner", ["field", "financials", "hr"])), "nope.nope")).toBe(
      false,
    );
  });

  it("walls dead letters and learned rules by their owning agent", () => {
    const viewer = check(actor("viewer", []));
    expect(canSeeAgent(viewer, "financials")).toBe(false);
    expect(canSeeAgent(viewer, "workforce")).toBe(false);
    expect(canSeeAgent(check(actor("staff", ["field"])), "dispatch")).toBe(true);
    // An agent with no kinds has nothing to justify a read.
    expect(canSeeAgent(check(actor("owner", ["field"])), "no-such-agent")).toBe(false);
  });
});

describe("registry invariants the DB depends on", () => {
  /**
   * propose() stamps agent_actions.department_key with
   * `spec.requires.departments?.[0]`, and the RESTRICTIVE policy in migration
   * 0029 checks that single value. If a kind ever declares two departments,
   * the stamp would silently enforce only the first — so hold the invariant
   * here rather than discovering it as a leak.
   */
  it("no kind declares more than one department", () => {
    for (const [kind, spec] of Object.entries(KINDS)) {
      expect(
        spec.requires.departments?.length ?? 0,
        `${kind} declares more than one department; agent_actions.department_key holds only one`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("every kind names an agent that owns at least one kind", () => {
    for (const [kind, spec] of Object.entries(KINDS)) {
      expect(canSeeAgent(() => {}, spec.owner), `${kind} owner ${spec.owner}`).toBe(true);
    }
  });
});
