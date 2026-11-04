import { describe, expect, it } from "vitest";
import { explainFinancing, monthlyPaymentCents } from "./financing";

describe("monthlyPaymentCents", () => {
  it("matches the standard amortization table", () => {
    // $10,000 at 9.99% APR for 60 months ≈ $212.42/mo (standard tables)
    expect(
      monthlyPaymentCents(1_000_000, { aprBps: 999, termMonths: 60, applyUrl: "" }),
    ).toBe(21_242);
  });
  it("0% APR divides evenly, half-up", () => {
    expect(monthlyPaymentCents(1_000_000, { aprBps: 0, termMonths: 12, applyUrl: "" })).toBe(
      83_333,
    );
  });
  it("rejects garbage", () => {
    expect(() => monthlyPaymentCents(0, { aprBps: 999, termMonths: 60, applyUrl: "" })).toThrow();
    expect(() => monthlyPaymentCents(100, { aprBps: 999, termMonths: 0, applyUrl: "" })).toThrow();
  });
});

describe("explainFinancing", () => {
  it("quotes figures verbatim in plain language", () => {
    expect(explainFinancing(1_000_000, { aprBps: 999, termMonths: 60, applyUrl: "" })).toBe(
      "As low as $212.42/mo for 60 months (9.99% APR, on approved credit through our financing partner).",
    );
  });
});
