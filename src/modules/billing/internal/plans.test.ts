import { describe, expect, it } from "vitest";
import { checkSeat, explainSubscription, isUpgrade, PLAN_LIST, PLANS, planFor } from "./plans";

describe("plan catalog", () => {
  it("is flat-priced with the locked numbers", () => {
    expect(PLANS.light.priceCents).toBe(9_900);
    expect(PLANS.light.seatCap).toBe(1);
    expect(PLANS.solo.priceCents).toBe(34_900);
    expect(PLANS.solo.seatCap).toBe(2);
    expect(PLANS.crew.priceCents).toBe(49_900);
    expect(PLANS.crew.seatCap).toBe(10);
    expect(PLANS.shop.priceCents).toBe(99_900);
    expect(PLANS.shop.seatCap).toBe(25);
  });

  it("every plan resolves to a DISTINCT Stripe lookup_key", () => {
    // ⛔ Prices are resolved at runtime by lookup_key. Two plans sharing one
    // key would silently bill the wrong amount, and it would look correct on
    // every screen because the display price comes from priceCents, not from
    // Stripe. The keys embed the amount so a stale one is visible on sight.
    const keys = PLAN_LIST.map((p) => p.lookupKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["os_light_99", "os_solo_349", "os_crew_499", "os_shop_999"]);
  });

  it("⛔ a plan is priced seats + capabilities, and NOTHING else", () => {
    // This test used to assert that a plan had no capability list at all
    // ("tiers sell seats, never features"). That rule was deliberately
    // replaced on 2026-08-14 — see the doctrine block in plans.ts. What
    // survives is the part that was actually protecting the customer: a plan
    // is these seven fields and no more. No usage meters, no overage rates,
    // no per-head multiplier, no "contact us to unlock" flag.
    for (const p of PLAN_LIST) {
      expect(Object.keys(p).sort()).toEqual(
        ["blurb", "key", "lookupKey", "name", "priceCents", "seatCap"],
      );
    }
  });

  it("PLAN_LIST is ordered cheapest first, which checkSeat depends on", () => {
    const prices = PLAN_LIST.map((p) => p.priceCents);
    const caps = PLAN_LIST.map((p) => p.seatCap);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(caps).toEqual([...caps].sort((a, b) => a - b));
  });

  it("resolves by key and rejects garbage", () => {
    expect(planFor("solo").name).toBe("Owner");
    expect(planFor("shop").name).toBe("Shop");
    expect(() => planFor("enterprise")).toThrow();
  });
  it("knows which direction a plan change goes", () => {
    expect(isUpgrade("solo", "crew")).toBe(true);
    expect(isUpgrade("crew", "shop")).toBe(true);
    expect(isUpgrade("shop", "crew")).toBe(false);
    expect(isUpgrade("crew", "solo")).toBe(false);
  });
});

describe("checkSeat", () => {
  it("allows while spots remain and counts them honestly", () => {
    const r = checkSeat("crew", 7);
    expect(r.allowed).toBe(true);
    expect(r.message).toBe("3 of your 10 spots are open.");
  });
  it("⛔ the owner's spouse does NOT trigger an upgrade", () => {
    // The whole point of a cap of 2. In this trade the second seat is the
    // person doing the books at the kitchen table, and billing a crew price
    // the moment she gets a login prices out the household the tier exists
    // to protect.
    const r = checkSeat("solo", 1);
    expect(r.allowed).toBe(true);
    expect(r.message).toBe("1 of your 2 spots is open.");
  });
  it("the third person is what moves them UP ONE rung, not to the top", () => {
    const r = checkSeat("solo", 2);
    expect(r.allowed).toBe(false);
    expect(r.suggestPlan).toBe("crew");
    expect(r.message).toContain("$499/mo");
    expect(r.message).toContain("10");
    expect(r.message).not.toContain("$999");
  });
  it("blocks at the cap and names the plan that fits", () => {
    const r = checkSeat("crew", 10);
    expect(r.allowed).toBe(false);
    expect(r.suggestPlan).toBe("shop");
    expect(r.message).toContain("$999/mo");
    expect(r.message).toContain("25");
  });
  it("at the top plan it points to a human, not a dead end", () => {
    const r = checkSeat("shop", 25);
    expect(r.allowed).toBe(false);
    expect(r.suggestPlan).toBeNull();
    expect(r.message).toContain("Give us a call");
  });
});

describe("explainSubscription", () => {
  const base = {
    plan: "crew" as const,
    status: "active",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: "2026-08-24T00:00:00Z",
    trialEndsAt: null,
  };
  it("states the active plan with figures verbatim", () => {
    expect(explainSubscription(base)).toBe(
      "You're on Crew: $499 a month, up to 10 people, everything included. Renews 2026-08-24.",
    );
  });
  it("states the bottom tier by its CUSTOMER-FACING name, not its key", () => {
    // The key is "solo" (and is baked into the live Stripe lookup_key), but a
    // husband-and-wife team should never be told they are on "Solo".
    expect(explainSubscription({ ...base, plan: "solo" })).toBe(
      "You're on Owner: $349 a month, up to 2 people, everything included. Renews 2026-08-24.",
    );
  });
  it("a pending cancel says exactly when it ends and how to undo", () => {
    const t = explainSubscription({ ...base, cancelAtPeriodEnd: true });
    expect(t).toContain("ends 2026-08-24");
    expect(t).toContain("brings it back");
  });
  it("past due never implies data loss", () => {
    const t = explainSubscription({ ...base, status: "past_due" });
    expect(t).toContain("nothing has been deleted");
  });
  it("canceled still promises the books", () => {
    expect(explainSubscription({ ...base, status: "canceled" })).toContain("still yours");
  });
});
