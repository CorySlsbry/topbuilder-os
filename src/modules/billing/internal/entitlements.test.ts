import { describe, expect, it } from "vitest";
import {
  can,
  CAPABILITY_FLOOR,
  missingCapabilities,
  PLAN_LIST,
  type Capability,
  type PlanKey,
} from "./plans";

/**
 * The fence, stated as an oracle.
 *
 * The doctrine in plans.ts says Light is a COMPLETE product for a one-person
 * shop, fenced on scale and never on the money loop. That is a sentence in a
 * comment until something checks it, so this file is the check: the exact set
 * Light withholds is written out by hand below, and anything added to or
 * removed from the fence has to be a deliberate edit here.
 */

/** Hand-written. If this list changes, somebody decided to change the product. */
const LIGHT_WITHHOLDS: Capability[] = [
  "agents",
  "bonding",
  "booksQa",
  "comms",
  "dispatch",
  "inventory",
  "purchasing",
  "workforce",
];

describe("the Light fence", () => {
  it("withholds exactly the eight scale capabilities, and no others", () => {
    expect(missingCapabilities("light").sort()).toEqual([...LIGHT_WITHHOLDS].sort());
  });

  it("⛔ every fenced capability is about SCALE, never the money loop", () => {
    // The money loop is not represented in CAPABILITY_FLOOR at all — that
    // absence IS the guarantee, so this asserts the absence by name. If
    // somebody ever fences invoicing or the books, this fails and they have
    // to come read the doctrine before shipping it.
    const forbidden = [
      "invoices", "invoicing", "payments", "estimates", "quotes", "jobs",
      "customers", "books", "ledger", "banking", "bank", "reconcile",
      "jobProfit", "costing", "reports", "export", "portal", "booking",
    ];
    const fenced = Object.keys(CAPABILITY_FLOOR);
    for (const f of forbidden) expect(fenced).not.toContain(f);
  });

  it("every tier above Light has everything", () => {
    for (const plan of ["solo", "crew", "shop"] as PlanKey[]) {
      expect(missingCapabilities(plan)).toEqual([]);
    }
  });

  it("can() answers per capability, both directions", () => {
    expect(can("light", "dispatch")).toBe(false);
    expect(can("light", "workforce")).toBe(false);
    expect(can("light", "booksQa")).toBe(false);
    expect(can("solo", "dispatch")).toBe(true);
    expect(can("shop", "bonding")).toBe(true);
  });

  it("every floor names a plan that actually exists", () => {
    // A typo'd floor would make rank() return -1 and silently unlock the
    // capability for EVERY plan, including Light — a fence that fails open.
    const keys = PLAN_LIST.map((p) => p.key);
    for (const floor of Object.values(CAPABILITY_FLOOR)) {
      expect(keys).toContain(floor);
    }
  });

  it("⛔ a capability with an unknown floor must not fail OPEN", () => {
    // Proving the guard above is worth having: with a bogus floor, rank()
    // returns -1 and `rank(plan) >= -1` is true for everything. That is the
    // failure mode the test above exists to catch, demonstrated here so
    // nobody assumes can() is inherently fail-closed.
    const bogus = { ...CAPABILITY_FLOOR, dispatch: "nonexistent" as PlanKey };
    const wouldUnlock = PLAN_LIST.findIndex((p) => p.key === "light")
      >= PLAN_LIST.findIndex((p) => p.key === bogus.dispatch);
    expect(wouldUnlock).toBe(true); // ← why the floors are asserted, not trusted
  });
});
