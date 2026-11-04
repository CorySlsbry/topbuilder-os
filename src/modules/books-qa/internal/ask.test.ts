import { describe, expect, it } from "vitest";
import { extractNumericTokens, verifyFigures } from "@/modules/agents";
import { deterministicAnswer, MAX_TOOL_CALLS, MAX_TURNS } from "./ask";

/**
 * The two behaviours worth pinning without a model in the loop.
 *
 * `askBooks` itself calls a provider, so it is exercised end to end by the
 * sweep (fail-closed without a key) and by a live probe. What is testable —
 * and what actually decides whether this feature is safe — is the firewall's
 * universe and what ships when it trips.
 */

describe("⛔ the figure firewall's universe is the TOOL RESULTS", () => {
  const results = [
    { tool: "cash_plan", args: {}, href: "/money", json: JSON.stringify({ low: 384210, weeks: 13 }) },
  ];

  function universeOf(rs: typeof results) {
    const u = new Set<string>();
    for (const r of rs) for (const t of extractNumericTokens(r.json)) u.add(t);
    return [...u];
  }

  it("⛔ with ZERO tool calls, ANY number fails", () => {
    // The case this exists for: "what was my revenue last month?" answered
    // confidently, with a figure, without looking anything up. An empty
    // universe means every digit is unsupported, which is correct.
    const verdict = verifyFigures("Your revenue was $84,000 last month.", universeOf([]));
    expect(verdict.ok).toBe(false);
  });

  it("a number that IS in a tool result passes", () => {
    expect(verifyFigures("Your low point is 384210 cents.", universeOf(results)).ok).toBe(true);
  });

  it("a number that is NOT in any tool result fails, even beside one that is", () => {
    // The realistic failure: one true figure lends credibility to an invented
    // one sitting next to it.
    const verdict = verifyFigures(
      "Your low point is 384210 cents, and you have 12 open jobs.",
      universeOf(results),
    );
    expect(verdict.ok).toBe(false);
  });

  it("prose with no figures at all is fine", () => {
    // "I don't know" must be sayable. A gate that rejected figure-free answers
    // would make the honest response impossible.
    expect(verifyFigures("I can't tell from your books yet.", universeOf([])).ok).toBe(true);
  });
});

describe("the fallback is a real answer, not an apology", () => {
  it("prefers the report's OWN explain sentence", () => {
    // Written by the same pure module that computed the figures, so it cannot
    // be wrong about a number. That is why the fallback is not a retry: this
    // is a better answer than a second guess would be.
    const text = deterministicAnswer([
      {
        tool: "cash_plan",
        args: {},
        href: "/money",
        json: JSON.stringify({ explain: "Your lowest point is $3,000.00 the week of 2026-08-10." }),
      },
    ]);
    expect(text).toBe("Your lowest point is $3,000.00 the week of 2026-08-10.");
  });

  it("finds an explain nested one level down", () => {
    const text = deterministicAnswer([
      {
        tool: "job_costing",
        args: { jobId: "j1" },
        href: "/wip",
        json: JSON.stringify({ jobNo: 4, explain: { wip: "" }, wip: { explain: "About 60% done." } }),
      },
    ]);
    expect(text).toContain("About 60% done.");
  });

  it("names the report rather than inventing prose when there is no explainer", () => {
    const text = deterministicAnswer([
      { tool: "owner_kpis", args: {}, href: "/money", json: JSON.stringify({ arDays: 41 }) },
    ]);
    expect(text).toContain("owner kpis");
    // ⛔ It must not state the figure it found. Rendering 41 here would be the
    // software inventing a sentence about a number, which is the entire thing
    // the firewall just refused to allow.
    expect(text).not.toContain("41");
  });

  it("says so plainly when nothing was looked up", () => {
    const text = deterministicAnswer([]);
    expect(text).toContain("couldn't look anything up");
    expect(text).not.toMatch(/\$|\d{3,}/);
  });
});

describe("the caps are small on purpose", () => {
  it("this answers a question; it does not explore", () => {
    // A loop that can call twenty tools is a loop that can spend real money on
    // one curious question.
    expect(MAX_TOOL_CALLS).toBeLessThanOrEqual(5);
    expect(MAX_TURNS).toBeLessThanOrEqual(6);
  });
});
