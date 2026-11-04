import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ⛔ A BANK LINE MATCHES ONLY AN ENTRY THAT MOVED CASH ON THAT ACCOUNT.
 *
 * The matching query cannot be unit-tested without a database, but the three
 * clauses that make it correct CAN be pinned — and each of them is one edit
 * away from re-opening a bug that silently doubles a real cost.
 *
 * The bug this replaced: money-out matched against `cost_entries`, unscoped
 * to the bank account and ordered by nothing. A bill entered through
 * purchasing writes a cost entry (DR job cost / CR PAYABLES — no cash moves)
 * and, later, a payment (DR payables / CR cash). So the check clearing the
 * bank matched nothing, sat in the queue, and got coded as a job cost —
 * booking the same materials twice. Or worse, it matched the AP-funded cost
 * entry, marking the line resolved against a posting that never touched the
 * bank, leaving book cash overstated by an amount with no transaction behind
 * it to find.
 */

const SRC = join(process.cwd(), "src", "modules", "bank-rec", "internal");

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const match = strip(readFileSync(join(SRC, "match.ts"), "utf8"));
const store = strip(readFileSync(join(SRC, "store.ts"), "utf8"));
const sync = strip(readFileSync(join(SRC, "feeds", "sync.ts"), "utf8"));

describe("the matching rule", () => {
  it("finds the query at all (guards a vacuous pass)", () => {
    expect(match).toContain("FROM journal_entries e");
  });

  it("⛔ is scoped to THIS account's ledger code", () => {
    // Without this the query can match an entry that moved money in a
    // different account entirely — or, fatally, one that moved no cash.
    expect(match, "the candidate entry must touch the bank account's own GL code").toMatch(
      /a\.code = \$1/,
    );
  });

  it("⛔ matches the correct SIDE of the entry", () => {
    // Money out of the bank is a CREDIT to cash; money in is a debit.
    // Matching the wrong side pairs a deposit with a cheque.
    expect(match).toContain("l.credit_cents");
    expect(match).toContain("l.debit_cents");
    expect(match).toMatch(/out \? "l\.credit_cents" : "l\.debit_cents"/);
  });

  it("⛔ never matches an entry a bank answer created", () => {
    // Those entries exist BECAUSE a bank line was categorized. Matching one
    // would let two lines claim the same posting and halve the transactions
    // reconciliation thinks it must account for.
    expect(match).toMatch(/source_type NOT IN \(/);
    for (const kind of ["bank-categorize", "bank-transfer", "bank-recategorize"]) {
      expect(match, `${kind} must be excluded`).toContain(kind);
    }
  });

  it("⛔ picks the CLOSEST date rather than whatever the planner returns", () => {
    // Two subs paid $2,400 in the same week is not exotic. LIMIT 1 with no
    // ORDER BY made which line matched which payment arbitrary.
    expect(match).toMatch(/ORDER BY abs\(e\.occurred_on/);
  });

  it("cannot claim an entry another line already holds", () => {
    expect(match).toMatch(/NOT EXISTS[\s\S]{0,120}bank_transactions/);
  });

  it("⛔ LINKS and never posts", () => {
    // The entry already exists — that is what a match MEANS. Anything that
    // posted here would be the double-count this module prevents.
    expect(match).not.toMatch(/postJournalEntry/);
    expect(match).not.toMatch(/INSERT INTO journal/);
  });
});

describe("one matcher, not two", () => {
  it("⛔ neither importer keeps a private copy", () => {
    // The file importer and the live feed had a copy each. Two copies is how
    // the feed's would have kept the bug after the importer's was fixed.
    for (const [name, src] of [["store.ts", store], ["feeds/sync.ts", sync]] as const) {
      expect(src, `${name} must not re-implement matching`).not.toMatch(
        /FROM \$\{table\}|tryAutoMatch|tryMatchExisting/,
      );
      expect(src, `${name} must call the shared matcher`).toContain("tryMatch(");
    }
  });

  it("both importers hand it the account's ledger code", () => {
    // Passing the account ID instead would compile and match nothing.
    for (const [name, src] of [["store.ts", store], ["feeds/sync.ts", sync]] as const) {
      expect(src, `${name} must pass bankGlCode`).toMatch(/bankGlCode:/);
    }
  });
});
