// Export forever — pure builders. Reversibility kills switching fear:
// the ledger leaves in one click, in formats QuickBooks (and any accountant
// tool) imports directly. Figures are verbatim ledger cents.
import type { GlDetailRow } from "@/modules/reporting";

function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** MM/DD/YYYY — the date shape IIF and QBO journal CSV both expect. */
function usDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function iifField(v: string): string {
  // IIF is tab-delimited; strip tabs/newlines rather than quote (IIF has no
  // reliable quoting) — memos survive, structure never breaks.
  return v.replace(/[\t\r\n]+/g, " ").trim();
}

interface EntryGroup {
  entryId: string;
  date: string;
  memo: string;
  lines: GlDetailRow[];
}

function groupByEntry(rows: GlDetailRow[]): EntryGroup[] {
  const groups = new Map<string, EntryGroup>();
  for (const r of rows) {
    let g = groups.get(r.entryId);
    if (!g) {
      g = { entryId: r.entryId, date: r.entryDate, memo: r.memo, lines: [] };
      groups.set(r.entryId, g);
    }
    g.lines.push(r);
  }
  return [...groups.values()];
}

/**
 * IIF general-journal export (TRNS/SPL/ENDTRNS). The first line of each
 * entry is TRNS; remaining lines are SPL; amounts are signed dollars
 * (debit positive, credit negative) and each transaction sums to zero.
 */
export function buildIifJournal(rows: GlDetailRow[]): string {
  const out: string[] = [
    "!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tMEMO",
    "!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tMEMO",
    "!ENDTRNS",
  ];
  for (const g of groupByEntry(rows)) {
    g.lines.forEach((l, i) => {
      const tag = i === 0 ? "TRNS" : "SPL";
      const amount = l.debitCents - l.creditCents;
      out.push(
        [
          tag,
          iifField(g.entryId),
          "GENERAL JOURNAL",
          usDate(l.entryDate),
          iifField(`${l.accountCode} ${l.accountName}`),
          dollars(amount),
          iifField(l.memo),
        ].join("\t"),
      );
    });
    out.push("ENDTRNS");
  }
  return out.join("\r\n") + "\r\n";
}

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * QBO journal-entry import CSV (the shape QBO's "Import journal entries"
 * accepts): JournalNo, JournalDate, Memo, AccountName, Debits, Credits.
 * Journal numbers are sequential per export; QBO only requires that lines
 * of one entry share a number.
 */
export function buildQboJournalCsv(rows: GlDetailRow[]): string {
  const out = ["JournalNo,JournalDate,Memo,AccountName,Debits,Credits"];
  groupByEntry(rows).forEach((g, i) => {
    for (const l of g.lines) {
      out.push(
        [
          csvEscape(i + 1),
          csvEscape(usDate(l.entryDate)),
          csvEscape(g.memo),
          csvEscape(`${l.accountCode} ${l.accountName}`),
          l.debitCents ? csvEscape(dollars(l.debitCents)) : "",
          l.creditCents ? csvEscape(dollars(l.creditCents)) : "",
        ].join(","),
      );
    }
  });
  return out.join("\r\n") + "\r\n";
}
