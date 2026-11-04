import { beforeAll, describe, expect, it } from "vitest";
import { buildIifJournal, buildQboJournalCsv } from "./export";
import {
  buildOpeningEntry,
  mapQboAccounts,
  qboAmountToCents,
  type NahbAccount,
  type QboAccount,
} from "./mapping";
import { centsToQboAmount, planSyncBatch } from "./syncplan";
import type { GlDetailRow } from "@/modules/reporting";

const GL: GlDetailRow[] = [
  {
    entryId: "e1",
    entryDate: "2026-07-20",
    memo: "Invoice #1001",
    accountCode: "1210",
    accountName: "Accounts receivable, trade",
    debitCents: 900_000,
    creditCents: 0,
    jobNo: 1,
    costCode: null,
  },
  {
    entryId: "e1",
    entryDate: "2026-07-20",
    memo: "Invoice #1001",
    accountCode: "3100",
    accountName: "Sales",
    debitCents: 0,
    creditCents: 900_000,
    jobNo: 1,
    costCode: null,
  },
  {
    entryId: "e2",
    entryDate: "2026-07-21",
    memo: 'Job cost, "ABC" supply',
    accountCode: "1430",
    accountName: "Direct construction cost",
    debitCents: 50_525,
    creditCents: 0,
    jobNo: 1,
    costCode: "4100",
  },
  {
    entryId: "e2",
    entryDate: "2026-07-21",
    memo: 'Job cost, "ABC" supply',
    accountCode: "1020",
    accountName: "Cash, general",
    debitCents: 0,
    creditCents: 50_525,
    jobNo: null,
    costCode: null,
  },
];

describe("buildIifJournal", () => {
  const iif = buildIifJournal(GL);
  it("emits headers, TRNS/SPL structure, ENDTRNS per entry", () => {
    const lines = iif.trim().split("\r\n");
    expect(lines[0]).toBe("!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tMEMO");
    expect(lines.filter((l) => l === "ENDTRNS")).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("TRNS\t"))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("SPL\t"))).toHaveLength(2);
  });
  it("each transaction sums to zero (debit positive, credit negative)", () => {
    expect(iif).toContain("9000.00");
    expect(iif).toContain("-9000.00");
    expect(iif).toContain("505.25");
    expect(iif).toContain("-505.25");
  });
  it("US dates and tab-safe memos", () => {
    expect(iif).toContain("07/20/2026");
    expect(iif).not.toMatch(/Job cost.*\t.*supply\t/); // memo tabs stripped
  });
});

describe("buildQboJournalCsv", () => {
  const csv = buildQboJournalCsv(GL);
  it("uses QBO's import header and one JournalNo per entry", () => {
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("JournalNo,JournalDate,Memo,AccountName,Debits,Credits");
    expect(lines[1]!.startsWith("1,")).toBe(true);
    expect(lines[3]!.startsWith("2,")).toBe(true);
  });
  it("escapes quoted memos and leaves the empty side blank", () => {
    expect(csv).toContain('"Job cost, ""ABC"" supply"');
    expect(csv).toContain("1210 Accounts receivable, trade".includes(",") ? '"1210 Accounts receivable, trade"' : "1210");
    expect(csv).toMatch(/9000\.00,\r\n|9000\.00,$/m); // credit column empty on the debit line? no — debit filled, credit empty
  });
});

describe("mapQboAccounts", () => {
  const chart: NahbAccount[] = [
    { code: "1020", name: "Cash, general", type: "asset" },
    { code: "1210", name: "Accounts receivable, trade", type: "asset" },
    { code: "2110", name: "Accounts payable, trade", type: "liability" },
    { code: "3100", name: "Sales, single-family, speculative", type: "revenue" },
    { code: "3810", name: "Cost of sales, labor", type: "cogs" },
    { code: "8010", name: "Salaries, officers", type: "expense" },
  ];
  const qbo: QboAccount[] = [
    { Id: "1", Name: "Checking", AcctNum: "1020", AccountType: "Bank" },
    { Id: "2", Name: "Accounts Receivable, Trade", AccountType: "Accounts Receivable" },
    { Id: "3", Name: "Roofing Income", AccountType: "Income" },
    { Id: "4", Name: "Weird thing", AccountType: "Mystery Type" },
  ];
  const r = mapQboAccounts(qbo, chart);
  it("prefers account-number, then name, then type default", () => {
    expect(r.mapped.find((m) => m.qboId === "1")).toMatchObject({ nahbCode: "1020", via: "number" });
    expect(r.mapped.find((m) => m.qboId === "2")).toMatchObject({ nahbCode: "1210", via: "name" });
    expect(r.mapped.find((m) => m.qboId === "3")).toMatchObject({ nahbCode: "3100", via: "type-default" });
  });
  it("reports the unmappable instead of dropping it", () => {
    expect(r.unmapped).toEqual([{ qboId: "4", qboName: "Weird thing", qboType: "Mystery Type" }]);
  });
});

describe("buildOpeningEntry", () => {
  const mapping = [
    { qboId: "1", qboName: "Checking", nahbCode: "1020", nahbName: "Cash", via: "number" as const },
    { qboId: "2", qboName: "Savings", nahbCode: "1020", nahbName: "Cash", via: "name" as const },
    { qboId: "3", qboName: "Loan", nahbCode: "2610", nahbName: "Notes payable", via: "number" as const },
  ];
  it("merges same-target accounts and balances", () => {
    const e = buildOpeningEntry(
      [
        { qboAccountId: "1", balanceCents: 300_000 },
        { qboAccountId: "2", balanceCents: 200_000 },
        { qboAccountId: "3", balanceCents: -500_000 },
      ],
      mapping,
    );
    expect(e.lines).toEqual([
      { accountCode: "1020", debitCents: 500_000, creditCents: 0 },
      { accountCode: "2610", debitCents: 0, creditCents: 500_000 },
    ]);
    expect(e.balanced).toBe(true);
  });
  it("an unbalanced source TB is refused, not fudged", () => {
    const e = buildOpeningEntry([{ qboAccountId: "1", balanceCents: 100 }], mapping);
    expect(e.balanced).toBe(false);
  });
  it("qboAmountToCents is exact and rejects garbage", () => {
    expect(qboAmountToCents("1234.56")).toBe(123_456);
    expect(qboAmountToCents(0.1 + 0.2)).toBe(30);
    expect(() => qboAmountToCents("abc")).toThrow();
  });
});

describe("planSyncBatch", () => {
  const accountIds = new Map([
    ["1210", "81"],
    ["3100", "82"],
    ["1020", "83"],
  ]);
  it("skips already-pushed entries and builds QBO payloads", () => {
    const { items, blocked } = planSyncBatch(GL, new Set(["e2"]), accountIds);
    expect(items).toHaveLength(1);
    expect(blocked).toHaveLength(0);
    const e1 = items[0]!;
    expect(e1.requestId).toBe("e1");
    expect(e1.payload.Line).toEqual([
      {
        Description: "Invoice #1001",
        Amount: 9000,
        DetailType: "JournalEntryLineDetail",
        JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "81" } },
      },
      {
        Description: "Invoice #1001",
        Amount: 9000,
        DetailType: "JournalEntryLineDetail",
        JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "82" } },
      },
    ]);
  });
  it("blocks (reports) entries touching unmapped accounts", () => {
    const { items, blocked } = planSyncBatch(GL, new Set(), new Map([["1210", "81"], ["3100", "82"]]));
    expect(items).toHaveLength(1); // e1 fine
    expect(blocked).toEqual([{ entryId: "e2", missingCodes: ["1430", "1020"] }]);
  });
  it("centsToQboAmount is 2dp exact", () => {
    expect(centsToQboAmount(50_525)).toBe(505.25);
    expect(centsToQboAmount(1)).toBe(0.01);
  });
});

describe("crypto round-trip", () => {
  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-for-vitest-only-0123456789";
  });
  it("encrypts and decrypts; tamper fails loudly", async () => {
    const { encryptToken, decryptToken } = await import("./crypto");
    const blob = encryptToken("refresh-token-secret");
    expect(blob.startsWith("v1:")).toBe(true);
    expect(blob).not.toContain("refresh-token-secret");
    expect(decryptToken(blob)).toBe("refresh-token-secret");
    const parts = blob.split(":");
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${Buffer.from("xxxx").toString("base64")}`;
    expect(() => decryptToken(tampered)).toThrow();
  });
});
