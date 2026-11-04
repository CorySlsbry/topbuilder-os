import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ⛔ A REVERSAL CARRIES THE ORIGINAL LINE'S DIMENSIONS, OR IT IS WRONG.
 *
 * `journal_lines` carries job / cost-code / class / customer / vendor, and
 * they are read: `reporting` builds P&L-by-job by joining `jobs ON j.id =
 * l.job_id`. A reversal written as
 *
 *     lines.map((l) => ({
 *       accountCode: l.accountCode,          // <- dimensions dropped here
 *       debitCents: l.creditCents || undefined,
 *       creditCents: l.debitCents || undefined,
 *     }))
 *
 * balances perfectly at the company level and leaves the original cost
 * sitting on that job's profit report with nothing offsetting it. The books
 * tie, the job report lies, and nothing anywhere fails. `voidInvoice` was
 * written exactly that way and shipped that way.
 *
 * The fix is one character — spread the line, THEN flip the sides — which is
 * also why it is worth a test: it is the kind of thing a future edit
 * "tidies" back out.
 */

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const files = walk(SRC)
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
  .map((f) => ({
    rel: f.slice(process.cwd().length + 1).replace(/\\/g, "/"),
    // Comments stripped first: this rule is explained in prose directly above
    // two of the call sites it governs, and a test that trips on its own
    // documentation is a test people delete.
    src: readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
  }));

describe("reversing a journal entry", () => {
  // `await` — so the ledger's own file, which DEFINES the reader, isn't
  // counted as a caller that forgot to spread its own return value.
  const callers = files.filter((f) => /await getEntryLinesTx\s*\(/.test(f.src));

  it("finds the reversal call sites at all (guards a vacuous pass)", () => {
    // Without this, a renamed helper would make every assertion below pass
    // over an empty list — the failure mode this whole file exists to catch.
    const names = callers.map((c) => c.rel);
    expect(names.length, `callers found: ${names.join(", ")}`).toBeGreaterThanOrEqual(2);
  });

  it("⛔ every caller spreads the original line instead of rebuilding it", () => {
    const rebuilt = callers
      .filter((f) => !/\.\.\.l\b/.test(f.src))
      .map((f) => f.rel);
    expect(
      rebuilt,
      "these reverse an entry without spreading the source line — the job / customer / class dimensions are dropped and the job-level P&L keeps the original amount forever. Write `{ ...l, debitCents: l.creditCents || undefined, creditCents: l.debitCents || undefined }`.",
    ).toEqual([]);
  });

  it("the ledger still HANDS BACK the dimensions there is a rule about", () => {
    // If the reader ever stops selecting them, spreading the line becomes a
    // no-op and the rule above goes quietly green while being false.
    const store = files.find((f) => f.rel.endsWith("modules/ledger/internal/store.ts"))!;
    const reader = /export async function getEntryLinesTx[\s\S]*?\n}/.exec(store.src)?.[0] ?? "";
    expect(reader).toMatch(/l\.job_id/);
    expect(reader).toMatch(/l\.cost_code/);
    expect(reader).toMatch(/l\.customer_id/);
  });
});

describe("correcting a bank line", () => {
  it("posts through the SAME function that categorized it the first time", () => {
    // Two copies of the posting rules means the correction path is the one
    // that drifts, and it is the path nobody looks at until an auditor does.
    const posting = files.filter((f) => /sourceType:\s*"bank-categorize"/.test(f.src));
    expect(posting.map((f) => f.rel)).toEqual(["src/modules/bank-rec/internal/store.ts"]);
  });

  it("⛔ never reverses the journal entry of a MATCHED line", () => {
    // A matched line's entry belongs to the payment that was already on the
    // books. Reversing it here would un-post a customer's payment because
    // somebody thought a bank statement row looked wrong.
    const rec = files.find((f) => f.rel.endsWith("bank-rec/internal/recategorize.ts"))!;
    expect(rec.src).toMatch(/status === "matched"/);
    // The matched branch returns before anything can post.
    const matchedBranch = /if \(txn\.status === "matched"\) \{[\s\S]*?\n {4}\}/.exec(rec.src)?.[0] ?? "";
    expect(matchedBranch).not.toMatch(/postJournalEntryTx|postResolutionTx/);
    expect(matchedBranch).toMatch(/return/);
  });

  it("offsets the job-cost row instead of trying to delete it", () => {
    // cost_entries is append-only by grant AND by trigger. A DELETE here
    // would fail at runtime, in a transaction, after the GL was already
    // reversed.
    const rec = files.find((f) => f.rel.endsWith("bank-rec/internal/recategorize.ts"))!;
    expect(rec.src).not.toMatch(/DELETE FROM cost_entries/i);
    expect(rec.src).toMatch(/INSERT INTO cost_entries/);
    expect(rec.src).toMatch(/-Number\(r\.amount_cents\)/);
  });
});
