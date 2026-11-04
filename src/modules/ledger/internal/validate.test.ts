import { describe, expect, it } from "vitest";
import { LedgerError, validateEntry, type EntryInput } from "./validate";

const good: EntryInput = {
  occurredOn: "2026-05-20",
  lines: [
    { accountCode: "1210", debitCents: 150000 },
    { accountCode: "3010", creditCents: 150000 },
  ],
};

function code(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
  return "NO_ERROR";
}

describe("validateEntry (pure ledger invariants)", () => {
  it("accepts a balanced two-line entry", () => {
    expect(() => validateEntry(good)).not.toThrow();
  });

  it("rejects an unbalanced entry", () => {
    expect(
      code(() =>
        validateEntry({
          ...good,
          lines: [
            { accountCode: "1210", debitCents: 150000 },
            { accountCode: "3010", creditCents: 149999 },
          ],
        }),
      ),
    ).toBe("entry_unbalanced");
  });

  it("rejects fewer than two lines", () => {
    expect(
      code(() => validateEntry({ ...good, lines: [good.lines[0]!] })),
    ).toBe("entry_needs_two_lines");
  });

  it("rejects a two-sided line", () => {
    expect(
      code(() =>
        validateEntry({
          ...good,
          lines: [
            { accountCode: "1210", debitCents: 100, creditCents: 100 },
            { accountCode: "3010", creditCents: 0 },
          ],
        }),
      ),
    ).toBe("line_must_be_one_sided");
  });

  it("rejects a zero-zero line", () => {
    expect(
      code(() =>
        validateEntry({
          ...good,
          lines: [{ accountCode: "1210" }, { accountCode: "3010", creditCents: 5 }],
        }),
      ),
    ).toBe("line_must_be_one_sided");
  });

  it("rejects float cents (money is integer cents, always)", () => {
    expect(
      code(() =>
        validateEntry({
          ...good,
          lines: [
            { accountCode: "1210", debitCents: 100.5 },
            { accountCode: "3010", creditCents: 100.5 },
          ],
        }),
      ),
    ).toBe("amounts_must_be_nonnegative_integer_cents");
  });

  it("rejects negative amounts (post the other side instead)", () => {
    expect(
      code(() =>
        validateEntry({
          ...good,
          lines: [
            { accountCode: "1210", debitCents: -5 },
            { accountCode: "3010", creditCents: -5 },
          ],
        }),
      ),
    ).toBe("amounts_must_be_nonnegative_integer_cents");
  });

  it("rejects a bad date", () => {
    expect(code(() => validateEntry({ ...good, occurredOn: "junk" }))).toBe(
      "invalid_date",
    );
  });
});
