import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ⛔ ONE DEFINITION OF PERCENT COMPLETE, OR THE LEDGER DISAGREES WITH THE
 * REPORT THAT PRODUCED IT.
 *
 * There were two. `buildCosting` (the /wip screen, the CPA pack, job profit)
 * falls back to `max(0, budget - costs)` when the owner has never typed an
 * estimate-to-complete. `getCipSchedule` (the bonding schedule) used
 * `etc ?? 0` — which makes estimated TOTAL cost equal costs-to-date, i.e.
 * 100% complete and fully earned, on a job that might be a week old.
 *
 * Same shop, same job, two answers. And the bonding one is the number
 * `postWipAdjustment` JOURNALIZES into 1265, 2480 and revenue — so the wrong
 * one was the one hitting the books, in the same week the CPA pack shipped
 * the other one to an accountant.
 *
 * Nothing caught it: both computations are individually correct, both are
 * covered by their own passing tests, and neither test knows the other
 * exists. Only reading them side by side does.
 */

const SRC = join(process.cwd(), "src", "modules", "job-costing", "internal");

function body(file: string): string {
  return readFileSync(join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("percent complete is computed one way", () => {
  const costing = body("costing.ts");
  const bonding = body("bonding.ts");

  it("finds both costing sites (guards a vacuous pass)", () => {
    expect(costing).toContain("estCostToCompleteCents");
    expect(bonding).toContain("estCostToCompleteCents");
  });

  it("⛔ neither site falls back to a bare zero for a missing ETC", () => {
    // `etc ?? 0` reads as harmless and means "this job is finished".
    const offenders: string[] = [];
    for (const [name, src] of [["costing.ts", costing], ["bonding.ts", bonding]] as const) {
      if (/estCostToCompleteCents:\s*Number\([^)]*\?\?\s*0\)/.test(src)) offenders.push(name);
    }
    expect(
      offenders,
      "a null estimate-to-complete must fall back to the remaining BUDGET, not to zero — zero means estimated total cost equals costs to date, which reports a brand-new job as 100% complete and fully earned",
    ).toEqual([]);
  });

  it("both sites fall back to the remaining budget", () => {
    for (const [name, src] of [["costing.ts", costing], ["bonding.ts", bonding]] as const) {
      expect(src, `${name} must use the remaining budget when ETC is null`).toMatch(
        /Math\.max\(0,\s*(Number\()?\s*(r\.)?budget/,
      );
    }
  });

  it("the bonding schedule reads the budget it needs to do that", () => {
    // Dropping budget_cents from the SELECT would make the fallback silently
    // NaN, which is worse than the bug it replaced.
    expect(bonding).toMatch(/j\.budget_cents/);
  });
});

/**
 * ⛔ CASH MEANS CASH.
 *
 * `CASH_CODES_SQL` unions every `bank_accounts.gl_account_code`, which was
 * harmless only while every connected account was a checking account. The
 * moment a credit card (2150) or a line of credit (2200) is added, its CREDIT
 * balance nets into "cash" on the weekly scoreboard, in the cash-flow
 * statement, and as the 13-week plan's starting balance — showing an owner
 * more money than they have, by exactly the amount they owe.
 */
describe("what counts as cash", () => {
  const reporting = readFileSync(
    join(process.cwd(), "src", "modules", "reporting", "internal", "store.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("⛔ excludes credit cards and credit lines from the cash accounts", () => {
    const rule = /CASH_CODES_SQL\s*=\s*`[\s\S]*?`/.exec(reporting)?.[0] ?? "";
    expect(rule, "CASH_CODES_SQL was not found — has it been renamed?").not.toBe("");
    expect(
      rule,
      "cash must be filtered to depository account kinds; a card's credit balance netting into cash overstates the bank by what the shop owes",
    ).toMatch(/kind IN \('checking','savings'\)/);
  });
});
