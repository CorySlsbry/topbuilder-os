import { describe, expect, it } from "vitest";
import { tellerAmountToCents, tellerKind } from "./teller";

/**
 * ⛔ THE TWO PLACES A SILENT CHANGE HERE INVERTS OR CORRUPTS EVERY
 * TRANSACTION IN THE SHOP.
 *
 * Amount parsing and account classification are the whole contract between
 * a provider and this product's ledger. Nothing downstream re-checks them:
 * a sign flip posts every purchase as income, and a credit card classified
 * as checking puts card debt on the balance sheet as negative cash.
 */

describe("parsing a Teller amount", () => {
  it("reads a signed decimal string into exact cents", () => {
    expect(tellerAmountToCents("-12.34")).toBe(-1234);
    expect(tellerAmountToCents("12.34")).toBe(1234);
    expect(tellerAmountToCents("0.07")).toBe(7);
    expect(tellerAmountToCents("1500")).toBe(150_000);
    expect(tellerAmountToCents("-1500.00")).toBe(-150_000);
  });

  it("⛔ does not go through a float", () => {
    // Math.round(Number("10.07") * 100) is 1007 by luck. Number("10.07")*100
    // is 1006.9999999999999, and the next value along is the one that bites.
    // Parsing the string is exact for every input, which is the only
    // standard that means anything for money.
    for (const [s, cents] of [
      ["10.07", 1007],
      ["1.005", null], // three decimals is not a real amount — reject it
      ["8.11", 811],
      ["29.97", 2997],
      ["-0.29", -29],
      ["123456789.99", 12_345_678_999],
    ] as const) {
      if (cents === null) {
        expect(() => tellerAmountToCents(s)).toThrow();
      } else {
        expect(tellerAmountToCents(s), s).toBe(cents);
      }
    }
  });

  it("handles a single decimal place the way a bank means it", () => {
    // "1.5" is a dollar fifty, not a dollar five.
    expect(tellerAmountToCents("1.5")).toBe(150);
  });

  it("throws rather than guessing at anything it does not understand", () => {
    // Returning 0 or NaN here would post a zero-amount transaction or a
    // corrupt one. An exception stops the sync, which is recoverable.
    for (const bad of ["", "abc", "1,234.00", "$12.34", "1.2.3", "--5"]) {
      expect(() => tellerAmountToCents(bad), bad).toThrow();
    }
  });
});

describe("classifying a Teller account", () => {
  it("⛔ a credit account is a CREDIT CARD, not a bank account", () => {
    // Getting this wrong posts card debt as negative cash on the balance
    // sheet a banker and a surety read first.
    expect(tellerKind("credit", "credit_card")).toBe("credit-card");
  });

  it("separates savings from checking", () => {
    expect(tellerKind("depository", "savings")).toBe("savings");
    expect(tellerKind("depository", "money_market")).toBe("savings");
    expect(tellerKind("depository", "checking")).toBe("checking");
  });

  it("falls back to checking for an unknown depository subtype", () => {
    // A wrong-but-harmless default. Checking is an asset like every other
    // depository account, so the balance sheet stays right even when the
    // label is imprecise — unlike defaulting a credit account.
    expect(tellerKind("depository", "something_new")).toBe("checking");
  });
});
