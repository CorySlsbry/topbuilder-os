import { describe, expect, it } from "vitest";
import {
  MODEL_RATES,
  costMicroUsd,
  overBudget,
  rateFor,
  ratesFromEnv,
  worstRate,
} from "./token-cost";

/**
 * The law this file exists to hold: A SPEND CAP MUST READ THE METER THAT
 * MEASURES THE THING IT GOVERNS — and a cap that has never been observed to
 * fire is indistinguishable from no cap.
 *
 * What it replaced: every production agent called
 * `finishRun(..., costMicroUsd: 0)`, so `agent_daily_costs` always read ZERO;
 * `books-qa` — the only multi-turn model loop, and by an order of magnitude the
 * biggest spender — called `checkBudget()` on the way in and then recorded its
 * spend NOWHERE, in either table. The cap was wired, called, and arithmetically
 * incapable of tripping.
 */

describe("costMicroUsd", () => {
  it("computes a hand-checkable number", () => {
    // Haiku 4.5 at $1/MTok in, $5/MTok out.
    // 1,000,000 in  = $1.00       = 1_000_000 microUSD
    // 1,000,000 out = $5.00       = 5_000_000 microUSD
    expect(costMicroUsd("claude-haiku-4-5-20251001", 1_000_000, 0)).toBe(1_000_000);
    expect(costMicroUsd("claude-haiku-4-5-20251001", 0, 1_000_000)).toBe(5_000_000);
    expect(costMicroUsd("claude-haiku-4-5-20251001", 1_000_000, 1_000_000)).toBe(6_000_000);
  });

  it("resolves a dated snapshot id by longest-prefix match", () => {
    expect(rateFor("claude-haiku-4-5-20251001")).toEqual(MODEL_RATES["claude-haiku-4-5"]);
    expect(rateFor("claude-sonnet-5")).toEqual(MODEL_RATES["claude-sonnet"]);
  });

  it("⛔ charges an UNKNOWN model at the most expensive known rate, never zero", () => {
    // The whole point: a model nobody added to the table must not be free.
    const unknown = costMicroUsd("some-model-we-have-never-seen", 1_000_000, 0);
    expect(unknown).toBe(worstRate(MODEL_RATES).inPerMTok * 1_000_000);
    expect(unknown).toBeGreaterThan(costMicroUsd("claude-haiku-4-5", 1_000_000, 0));
  });

  it("⛔ never rounds a real call down to zero", () => {
    // A million calls each rounding to 0 sums to 0 — the exact shape of the bug
    // this replaces. One token still costs at least one micro-dollar.
    //   1 input token  @ $1/MTok = 1e-6 USD -> ceil = 1 microUSD
    //   1 output token @ $5/MTok = 5e-6 USD -> ceil = 5 microUSD
    expect(costMicroUsd("claude-haiku-4-5", 1, 0)).toBe(1);
    expect(costMicroUsd("claude-haiku-4-5", 0, 1)).toBe(5);
    // and the floor holds even for a rate small enough to underflow
    expect(costMicroUsd("cheap", 1, 0, { cheap: { inPerMTok: 0.000001, outPerMTok: 0 } })).toBe(1);
  });

  it("a call that used nothing costs nothing", () => {
    expect(costMicroUsd("claude-haiku-4-5", 0, 0)).toBe(0);
  });

  it("treats missing or negative token counts as zero rather than throwing", () => {
    // Provider payloads have been known to omit `usage`. Metering must degrade,
    // not 500 — but it must degrade toward zero cost only when there is truly
    // nothing to charge.
    expect(costMicroUsd("claude-haiku-4-5", NaN, NaN)).toBe(0);
    expect(costMicroUsd("claude-haiku-4-5", -5, -5)).toBe(0);
  });
});

describe("ratesFromEnv", () => {
  it("parses the documented format", () => {
    expect(ratesFromEnv("claude-haiku-4-5:1.10/5.50,claude-sonnet:3/15")).toEqual({
      "claude-haiku-4-5": { inPerMTok: 1.1, outPerMTok: 5.5 },
      "claude-sonnet": { inPerMTok: 3, outPerMTok: 15 },
    });
  });

  it("an override actually changes the price", () => {
    const o = ratesFromEnv("claude-haiku-4-5:2/10");
    expect(costMicroUsd("claude-haiku-4-5-20251001", 1_000_000, 0, o)).toBe(2_000_000);
  });

  it("ignores malformed and negative entries instead of dying", () => {
    expect(ratesFromEnv("nonsense")).toEqual({});
    expect(ratesFromEnv("claude-haiku:-1/5")).toEqual({});
    expect(ratesFromEnv("")).toEqual({});
    expect(ratesFromEnv(undefined)).toEqual({});
  });
});

describe("overBudget — the decision the cap actually makes", () => {
  it("⛔ TRIPS at and above the cap", () => {
    expect(overBudget(5_000_000, 5_000_000)).toBe(true); // exactly on it counts
    expect(overBudget(5_000_001, 5_000_000)).toBe(true);
  });

  it("does not trip below the cap", () => {
    expect(overBudget(4_999_999, 5_000_000)).toBe(false);
    expect(overBudget(0, 5_000_000)).toBe(false);
  });

  it("⛔ a cap of zero or nonsense is a KILL SWITCH, not an open door", () => {
    // Fail closed: a misconfigured cap must stop spending, not permit it.
    expect(overBudget(0, 0)).toBe(true);
    expect(overBudget(0, -1)).toBe(true);
    expect(overBudget(0, NaN)).toBe(true);
  });
});
