import { describe, expect, it } from "vitest";
import {
  detectFormat,
  fingerprint,
  normalizeDescription,
  parseCsvStatement,
  parseOfx,
  ruleMatcherFrom,
} from "./parse";

describe("CSV statement parsing", () => {
  it("parses signed single-amount layout (Chase-style)", () => {
    const r = parseCsvStatement(
      "Posting Date,Description,Amount\n07/01/2026,HOME DEPOT #1234,-842.00\n07/02/2026,Customer deposit,9000.00",
    );
    expect(r.skipped).toBe(0);
    expect(r.txns).toEqual([
      { postedOn: "2026-07-01", amountCents: -84200, description: "HOME DEPOT #1234" },
      { postedOn: "2026-07-02", amountCents: 900000, description: "Customer deposit" },
    ]);
  });

  it("parses debit/credit two-column layout", () => {
    const r = parseCsvStatement(
      "Date,Description,Debit,Credit\n2026-07-03,NETFLIX.COM,15.49,\n2026-07-05,Check 1044,,9000.00",
    );
    expect(r.txns[0]).toEqual({
      postedOn: "2026-07-03",
      amountCents: -1549,
      description: "NETFLIX.COM",
    });
    expect(r.txns[1]!.amountCents).toBe(900000);
  });

  it("handles accounting-style parentheses and $ commas", () => {
    const r = parseCsvStatement(
      'Date,Description,Amount\n2026-07-04,"SRS DISTRIBUTION","($2,000.00)"',
    );
    expect(r.txns[0]!.amountCents).toBe(-200000);
  });

  it("skips unparseable rows and REPORTS them (never a silent zero)", () => {
    const r = parseCsvStatement(
      "Date,Description,Amount\nnot-a-date,thing,12.00\n2026-07-04,ok,1.00",
    );
    expect(r.skipped).toBe(1);
    expect(r.txns).toHaveLength(1);
  });

  it("rejects an unrecognizable layout wholesale", () => {
    const r = parseCsvStatement("a,b\n1,2");
    expect(r.txns).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });
});

describe("OFX parsing", () => {
  const OFX = `
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260701120000
<TRNAMT>-842.00
<NAME>HOME DEPOT #1234
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260705
<TRNAMT>9000.00
<MEMO>Check 1044 deposit
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  it("extracts STMTTRN blocks (SGML style, NAME or MEMO)", () => {
    const r = parseOfx(OFX);
    expect(r.skipped).toBe(0);
    expect(r.txns).toEqual([
      { postedOn: "2026-07-01", amountCents: -84200, description: "HOME DEPOT #1234" },
      { postedOn: "2026-07-05", amountCents: 900000, description: "Check 1044 deposit" },
    ]);
  });

  it("detectFormat picks OFX by extension or content", () => {
    expect(detectFormat("july.qfx", "")).toBe("ofx");
    expect(detectFormat("data.txt", OFX)).toBe("ofx");
    expect(detectFormat("july.csv", "a,b")).toBe("csv");
  });
});

describe("fingerprint + rule matcher", () => {
  const txn = { postedOn: "2026-07-01", amountCents: -84200, description: "HOME DEPOT  #1234" };

  it("is stable across whitespace/case noise", () => {
    const a = fingerprint("acct-1", txn);
    const b = fingerprint("acct-1", { ...txn, description: "home depot #1234" });
    expect(a).toBe(b);
  });

  it("differs across accounts and amounts", () => {
    expect(fingerprint("acct-1", txn)).not.toBe(fingerprint("acct-2", txn));
    expect(fingerprint("acct-1", txn)).not.toBe(
      fingerprint("acct-1", { ...txn, amountCents: -84201 }),
    );
  });

  it("normalizeDescription collapses noise", () => {
    expect(normalizeDescription("  HOME   DEPOT  ")).toBe("home depot");
  });

  it("ruleMatcherFrom strips store numbers", () => {
    expect(ruleMatcherFrom("HOME DEPOT #1234")).toBe("home depot");
    expect(ruleMatcherFrom("NETFLIX.COM (555) 010-0100")).toBe("netflix.com");
  });
});
