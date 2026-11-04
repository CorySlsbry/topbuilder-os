// Accountant Sync planning — pure. Our ledger is append-only, so the sync
// is CREATE-only: each of our journal entries becomes one QBO JournalEntry,
// idempotent two ways — entries already in the entity map are skipped, and
// each POST carries requestid=<our entry id> so QBO dedupes retries itself.
import type { GlDetailRow } from "@/modules/reporting";

export interface QboJournalLine {
  Description: string;
  Amount: number;
  DetailType: "JournalEntryLineDetail";
  JournalEntryLineDetail: {
    PostingType: "Debit" | "Credit";
    AccountRef: { value: string };
  };
}

export interface QboJournalEntryPayload {
  TxnDate: string;
  PrivateNote: string;
  Line: QboJournalLine[];
}

export interface SyncItem {
  localEntryId: string;
  requestId: string;
  payload: QboJournalEntryPayload;
}

/** cents → QBO decimal dollars (number, 2dp exact). */
export function centsToQboAmount(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

/**
 * Build the push batch: GL rows grouped by entry, minus entries already in
 * the entity map, each line's AccountRef resolved via the account map
 * (NAHB code -> QBO account id). Entries touching an unmapped account are
 * reported, not silently skipped.
 */
export function planSyncBatch(
  rows: GlDetailRow[],
  alreadyPushed: Set<string>,
  accountIdByCode: Map<string, string>,
): { items: SyncItem[]; blocked: { entryId: string; missingCodes: string[] }[] } {
  const groups = new Map<string, GlDetailRow[]>();
  for (const r of rows) {
    if (alreadyPushed.has(r.entryId)) continue;
    const g = groups.get(r.entryId) ?? [];
    g.push(r);
    groups.set(r.entryId, g);
  }

  const items: SyncItem[] = [];
  const blocked: { entryId: string; missingCodes: string[] }[] = [];
  for (const [entryId, lines] of groups) {
    const missing = [
      ...new Set(
        lines
          .map((l) => l.accountCode)
          .filter((c) => !accountIdByCode.has(c)),
      ),
    ];
    if (missing.length > 0) {
      blocked.push({ entryId, missingCodes: missing });
      continue;
    }
    items.push({
      localEntryId: entryId,
      requestId: entryId,
      payload: {
        TxnDate: lines[0]!.entryDate,
        PrivateNote: `${lines[0]!.memo} [TopBuilder ${entryId}]`,
        Line: lines.map((l) => ({
          Description: l.memo,
          Amount: centsToQboAmount(l.debitCents || l.creditCents),
          DetailType: "JournalEntryLineDetail" as const,
          JournalEntryLineDetail: {
            PostingType: l.debitCents > 0 ? ("Debit" as const) : ("Credit" as const),
            AccountRef: { value: accountIdByCode.get(l.accountCode)! },
          },
        })),
      },
    });
  }
  return { items, blocked };
}
