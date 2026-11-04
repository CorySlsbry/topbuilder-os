import "server-only";
import type { PoolClient } from "pg";

/**
 * Matching a bank line to money already on the books.
 *
 * ── THE RULE, WHICH USED TO BE A HEURISTIC ───────────────────────────────
 * A bank line can only match a journal entry that ACTUALLY MOVED CASH ON
 * THIS BANK ACCOUNT, in this direction, for this amount. That is the whole
 * rule, it is one query, and it makes two separate bugs impossible at once.
 *
 * What it replaces: a table switch. Money in looked at `payments`; money out
 * looked at `cost_entries`. Both were unscoped to the bank account, ordered
 * by nothing, and — the expensive part — `cost_entries` is written by BILLS,
 * which do not touch cash.
 *
 * ── BUG ONE: THE SAME COST BOOKED TWICE ──────────────────────────────────
 * Enter a bill through purchasing and two things happen at different times:
 *
 *     bill entered   DR 1430 job cost   CR 2110 accounts payable   (a cost)
 *     bill paid      DR 2110 payable    CR 1020 cash               (the cash)
 *
 * When the check clears, the bank line should match the PAYMENT. It never
 * looked at `bill_payments`, so nothing matched, the line sat in the queue,
 * and the bookkeeper coded it as a job cost — booking the same materials a
 * second time. The job looks worse than it is, and by exactly the amount
 * that is hardest to notice: a real number, from a real receipt.
 *
 * ── BUG TWO: THE WRONG MATCH, WHICH IS WORSE ─────────────────────────────
 * The same query could match a bank line against an AP-FUNDED cost entry —
 * one whose journal entry credited 2110, not cash. The line was marked
 * resolved and linked to an entry that never moved a dollar out of the bank,
 * so book cash stayed overstated by the payment and reconciliation failed by
 * an amount with no transaction behind it to find.
 *
 * Requiring the candidate entry to credit (or debit) THIS ACCOUNT'S ledger
 * code fixes both: a bill's cost entry credits payables and can never match,
 * a bill payment credits cash and matches correctly.
 *
 * ── ONE COPY, DELIBERATELY ───────────────────────────────────────────────
 * The file importer and the live feed both need this. They had a copy each,
 * which is how the feed's copy would have kept the bug after the importer's
 * was fixed.
 */

export interface MatchResult {
  journalEntryId: string;
  /** What produced the entry — shown to the human so a match is checkable. */
  sourceType: string;
  memo: string;
  occurredOn: string;
}

/** How far either side of the bank's date a real entry may sit. Banks post a
 *  check days after it was written; ±5 covers a weekend plus a holiday. */
const WINDOW_DAYS = 5;

/**
 * Find the entry this bank line already represents, or null.
 *
 * Never posts, never modifies — the caller decides what to do with a match,
 * and linking is a status change, not a journal entry.
 */
export async function findMatchingEntry(
  c: PoolClient,
  input: {
    /** The ledger code of the account this line belongs to. */
    bankGlCode: string;
    /** SIGNED cents: negative is money out. */
    amountCents: number;
    postedOn: string;
  },
): Promise<MatchResult | null> {
  const abs = Math.abs(input.amountCents);
  const out = input.amountCents < 0;

  const { rows } = await c.query<{
    id: string;
    source_type: string;
    memo: string;
    occurred_on: string;
  }>(
    `SELECT e.id, e.source_type, e.memo, e.occurred_on::text AS occurred_on
       FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id
       JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE a.code = $1
        -- Money OUT of the bank is a CREDIT to the cash account; money in is
        -- a debit. Matching the wrong side would pair a deposit with a check.
        AND ${out ? "l.credit_cents" : "l.debit_cents"} = $2
        -- $4::int, explicitly: node-pg sends parameters untyped, and Postgres
        -- resolves "date - unknown" as date-minus-DATE — an integer — which
        -- makes the BETWEEN read "date >= integer" and throw on the first
        -- real import. The cast pins the date-minus-days overload.
        AND e.occurred_on BETWEEN $3::date - $4::int AND $3::date + $4::int
        -- Not already claimed by another bank line.
        AND NOT EXISTS (
          SELECT 1 FROM bank_transactions b WHERE b.journal_entry_id = e.id
        )
        -- ⛔ NEVER an entry that a bank line's own categorization created.
        -- Those entries exist BECAUSE a bank line was answered; matching one
        -- would let two bank lines claim the same posting and quietly halve
        -- the transactions the reconciliation thinks it has to account for.
        AND e.source_type NOT IN ('bank-categorize', 'bank-transfer', 'bank-recategorize')
      -- Closest date first. LIMIT 1 with no ORDER BY meant that when a shop
      -- paid two subs $2,400 in the same week, which line matched which
      -- payment was down to whatever the planner felt like returning.
      ORDER BY abs(e.occurred_on - $3::date), e.created_at
      LIMIT 1`,
    [input.bankGlCode, abs, input.postedOn, WINDOW_DAYS],
  );

  const r = rows[0];
  return r
    ? {
        journalEntryId: r.id,
        sourceType: r.source_type,
        memo: r.memo,
        occurredOn: r.occurred_on,
      }
    : null;
}

/**
 * Link a bank line to money already on the books.
 *
 * ⛔ POSTS NOTHING. The entry already exists — that is the entire point of a
 * match. Anything that posted here would be the double-count this module was
 * written to prevent.
 */
export async function linkMatch(
  c: PoolClient,
  txnId: string,
  journalEntryId: string,
  uid: string,
): Promise<void> {
  await c.query(
    `UPDATE bank_transactions
        SET status = 'matched', journal_entry_id = $2,
            resolved_by = $3, resolved_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [txnId, journalEntryId, uid],
  );
}

/** Find and link in one step — what both importers actually want. */
export async function tryMatch(
  c: PoolClient,
  input: {
    txnId: string;
    bankGlCode: string;
    amountCents: number;
    postedOn: string;
    uid: string;
  },
): Promise<MatchResult | null> {
  const found = await findMatchingEntry(c, input);
  if (found) await linkMatch(c, input.txnId, found.journalEntryId, input.uid);
  return found;
}
