import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Structural guards on the spend meter.
 *
 * The bug these exist to prevent is not a wrong number — it is a MISSING one.
 * `assist_usage.cost_microusd` is half of what `checkBudget` sums, and a row
 * written without it reads as a perfectly legal 0. So the failure is silent by
 * construction: the cap simply never trips, and nothing anywhere logs a
 * complaint. Exactly how it broke the first time.
 *
 * Both rules below are about that silence:
 *   ONE WRITER  — a fourth hand-rolled INSERT would forget the cost.
 *   ONE METER   — recording the same spend in both tables would double-charge.
 */

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

describe("assist_usage has exactly ONE writer", () => {
  it("⛔ only assist-usage.ts contains `INSERT INTO assist_usage`", () => {
    const writers = walk(SRC).filter((f) =>
      /INSERT\s+INTO\s+assist_usage/i.test(readFileSync(f, "utf8")),
    );
    expect(writers.map((f) => f.replace(SRC, "src"))).toEqual([
      join("src", "modules", "agents", "internal", "assist-usage.ts"),
    ]);
  });

  it("that writer computes the cost itself, so no caller can skip it", () => {
    const src = readFileSync(join(SRC, "modules/agents/internal/assist-usage.ts"), "utf8");
    expect(src).toContain("costMicroUsd(");
    expect(src).toContain("cost_microusd");
    // Rates must be read from the environment at call time, or the documented
    // override is decoration.
    expect(src).toContain("ratesFromEnv(process.env.AGENT_MODEL_RATES)");
  });
});

describe("a model call is metered ONCE", () => {
  const ask = readFileSync(join(SRC, "modules/books-qa/internal/ask.ts"), "utf8");

  it("books-qa records its spend in assist_usage", () => {
    expect(ask).toContain("recordAssistUsage(");
    // In a finally, so the throw path and the firewall-fallback path pay too.
    expect(ask).toMatch(/finally\s*\{[\s\S]*recordAssistUsage\(/);
  });

  it("⛔ books-qa does NOT also pass costMicroUsd to finishRun", () => {
    // checkBudget sums BOTH agent_daily_costs and assist_usage. Recording the
    // same tokens in both would charge the shop twice for one question and trip
    // its cap at half the real spend.
    //
    // Matches the PROPERTY (`costMicroUsd:`), not the bare word — the file
    // explains this rule in a comment, and a test that forbids naming the thing
    // it is about forbids documenting it.
    expect(ask).not.toMatch(/costMicroUsd\s*:/);
  });

  it("books-qa accumulates tokens across turns, not just the last response", () => {
    // Six round trips, each separately billed; reading only the final response
    // would under-count by roughly the number of turns.
    expect(ask).toContain("inputTokens +=");
    expect(ask).toContain("outputTokens +=");
  });
});

describe("the cap reads both meters", () => {
  const runs = readFileSync(join(SRC, "modules/agents/internal/runs.ts"), "utf8");

  it("⛔ checkBudget sums assist_usage as well as agent_daily_costs", () => {
    expect(runs).toContain("FROM agent_daily_costs");
    expect(runs).toContain("FROM assist_usage");
  });

  it("what the screen shows and what the cap enforces come from one function", () => {
    // If getDailyCost and checkBudget could disagree, the UI would say there is
    // budget left while the helper refused to run.
    expect(runs).toContain("spentTodayMicroUsd");
    const uses = runs.match(/spentTodayMicroUsd\(scope\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  it("the decision is the pure overBudget(), which has its own tests", () => {
    expect(runs).toContain("overBudget(spent, DAILY_CAP_MICROUSD)");
  });
});
