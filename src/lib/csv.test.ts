import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRecords } from "./csv";

describe("parseCsv", () => {
  it("parses plain rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with commas (the NAHB 'Cash, general' case)", () => {
    expect(parseCsv('1020,"Cash, general",asset')).toEqual([
      ["1020", "Cash, general", "asset"],
    ]);
  });

  it("handles escaped quotes and CRLF", () => {
    expect(parseCsv('a,"say ""hi""",c\r\nx,y,z')).toEqual([
      ["a", 'say "hi"', "c"],
      ["x", "y", "z"],
    ]);
  });

  it("handles newlines inside quotes", () => {
    expect(parseCsv('a,"line1\nline2",c')).toEqual([["a", "line1\nline2", "c"]]);
  });

  it("parseCsvRecords keys by header", () => {
    expect(parseCsvRecords("Account,Name\n1020,Cash")).toEqual([
      { Account: "1020", Name: "Cash" },
    ]);
  });
});
