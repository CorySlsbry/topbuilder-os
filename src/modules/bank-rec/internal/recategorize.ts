import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { getEntryLinesTx, postJournalEntryTx } from "@/modules/ledger";
import {
  BankError,
  postResolutionTx,
  recordResolution,
  type ResolveAction,
} from "./store";

/**
 * Change the answer on a bank line that is already posted.
 *
 * Everyone miscodes. The supply-house charge that was really for the Nguyen
 * job, the "office supplies" that turn out to be a personal Amazon order, the
 * deposit coded to revenue that was the owner putting money in. A set of
 * books you cannot correct is a set of books people quietly stop using, and
 * then the shop is back to a shoebox.
 *
 * ── A CORRECTION IS TWO POSTINGS, NEVER AN EDIT ──────────────────────────
 * The journal is immutable (0002: no UPDATE, no DELETE, by grant AND by
 * trigger). So this does exactly what a CPA does by hand:
 *
 *     1. reverse the original entry, line for line, DIMENSIONS AND ALL
 *     2. post the new answer
 *     3. append a row to the correction log saying who and why
 *
 * Both postings stay in the ledger forever. That is what separates a
 * correction from a cover-up, and it is the reason these books can be handed
 * to a surety or a lender without a caveat.
 *
 * ── THREE THINGS THAT WOULD BE WRONG AND ARE NOT ─────────────────────────
 *
 * `matched` lines are NOT reversed. A matched line is one where the bank
 * statement met a payment or a cost THAT WAS ALREADY ON THE BOOKS — the
 * journal entry belongs to the invoice payment, not to the bank line.
 * Reversing it here would un-post a customer's payment because somebody
 * thought a bank line looked wrong. The only correction available is to
 * UNLINK, which puts the line back in the queue and leaves the payment alone.
 *
 * `cost_entries` get an offsetting row, not a delete. That table is
 * append-only for the same reason the journal is, and a job cost reversed
 * only in the GL would sit on the wrong job's cost report forever. Every
 * reader SUMs, so a negative row nets it to zero with no other code change.
 *
 * A CLOSED MONTH stays closed. If the line's own month is locked the
 * correction books today instead, and says so in the memo. Reversal and
 * re-post always share a date, so a correction inside an open month nets to
 * zero within that month and moves no report.
 */

export interface RecategorizeResult {
  status: string;
  journalEntryId: string | null;
  undoEntryId: string | null;
  /** The date the correction actually booked — today if the month was closed. */
  bookedOn: string;
  seq: number;
}

/** Actions that make sense on an ALREADY-posted line. */
export type CorrectionAction = ResolveAction | { type: "unmatch" };

export async function recategorizeBankTxn(
  scope: TenantScope,
  txnId: string,
  action: CorrectionAction,
  reason: string,
): Promise<RecategorizeResult> {
  if (!reason.trim()) throw new BankError(422, "reason_required");

  return withTenant(scope, async (c) => {
    // FOR UPDATE for the same reason the first categorization takes it: this
    // reads a status and a journal entry, then writes both. Two people
    // correcting the same line at once would otherwise each reverse the
    // original and both post a replacement — the line would be double-counted
    // and the ledger would be right about everything except reality.
    const { rows } = await c.query<{
      id: string;
      bank_account_id: string;
      posted_on: string;
      amount_cents: string;
      description: string;
      status: string;
      journal_entry_id: string | null;
    }>(
      `SELECT id, bank_account_id, posted_on::text AS posted_on, amount_cents,
              description, status, journal_entry_id
         FROM bank_transactions WHERE id = $1 FOR UPDATE`,
      [txnId],
    );
    const txn = rows[0];
    if (!txn) throw new BankError(404, "txn_not_found");
    if (txn.status === "pending") {
      // Not an error the user can hit from the screen, but worth being loud
      // about: correcting an unanswered line would post a reversal of nothing.
      throw new BankError(422, "txn_not_yet_categorized");
    }

    const seq = await nextSeq(c, txnId);

    // ── matched lines: unlink only ─────────────────────────────────────────
    if (txn.status === "matched") {
      if (action.type !== "unmatch") throw new BankError(422, "matched_line_must_be_unlinked_first");
      await c.query(
        `UPDATE bank_transactions
            SET status = 'pending', journal_entry_id = NULL,
                resolved_by = $2, resolved_at = now()
          WHERE id = $1`,
        [txnId, scope.uid],
      );
      await recordResolution(c, scope, txnId, seq, { type: "unmatch" }, null, null, reason);
      return {
        status: "pending",
        journalEntryId: null,
        undoEntryId: null,
        bookedOn: txn.posted_on,
        seq,
      };
    }
    if (action.type === "unmatch") throw new BankError(422, "not_a_matched_line");

    const bookedOn = await correctionDate(c, txn.posted_on);
    const closedMonth = bookedOn !== txn.posted_on;

    // ── 1. reverse what is there ──────────────────────────────────────────
    let undoEntryId: string | null = null;
    if (txn.journal_entry_id) {
      const lines = await getEntryLinesTx(c, txn.journal_entry_id);
      undoEntryId = await postJournalEntryTx(c, scope, {
        occurredOn: bookedOn,
        memo: closedMonth
          ? `Recoded (${txn.posted_on} is closed): ${txn.description}`
          : `Recoded: ${txn.description}`,
        sourceType: "bank-recategorize",
        sourceId: txnId,
        lines: lines.map((l) => ({
          ...l,
          debitCents: l.creditCents || undefined,
          creditCents: l.debitCents || undefined,
        })),
      });

      // The operational job-cost ledger needs the same treatment. Found by
      // the journal entry rather than by the audit log on purpose: lines
      // categorized before this feature existed have no audit row, and they
      // are exactly the ones most likely to need fixing.
      await offsetCostEntries(c, scope, txn.journal_entry_id, undoEntryId, bookedOn);
    }

    // ── 2. post the new answer, through the SAME code that posts a first
    //       categorization — see postResolutionTx ─────────────────────────
    const acct = await c.query<{ gl_account_code: string }>(
      "SELECT gl_account_code FROM bank_accounts WHERE id = $1",
      [txn.bank_account_id],
    );
    const { status, journalEntryId } = await postResolutionTx(
      c,
      scope,
      {
        id: txn.id,
        description: txn.description,
        amountCents: Number(txn.amount_cents),
        postedOn: txn.posted_on,
      },
      action,
      acct.rows[0]!.gl_account_code,
      bookedOn,
    );

    // journal_entry_id is SET, not COALESCE'd: the line now points at its new
    // posting. The old one is still in the ledger, reachable through the
    // reversal and through the correction log.
    await c.query(
      `UPDATE bank_transactions
          SET status = $2, journal_entry_id = $3, resolved_by = $4, resolved_at = now()
        WHERE id = $1`,
      [txnId, status, journalEntryId, scope.uid],
    );
    // A duplicate seq means somebody else corrected this same line while we
    // were working. UNIQUE(tenant_id, txn_id, seq) turns that into a 23505,
    // which aborts the whole transaction — reversal, re-post and all — rather
    // than letting two corrections stack into a double reversal. The row lock
    // above makes it near-impossible; this is what catches the case where it
    // is not (a retried request whose first attempt committed).
    try {
      await recordResolution(c, scope, txnId, seq, action, journalEntryId, undoEntryId, reason);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new BankError(409, "changed_by_someone_else");
      }
      throw err;
    }

    return { status, journalEntryId, undoEntryId, bookedOn, seq };
  });
}

async function nextSeq(c: PoolClient, txnId: string): Promise<number> {
  const { rows } = await c.query<{ n: string | null }>(
    "SELECT MAX(seq) AS n FROM bank_txn_resolutions WHERE txn_id = $1",
    [txnId],
  );
  // No rows means either a brand-new line or one categorized before the log
  // existed. Either way the correction is the SECOND answer, not the first —
  // starting at 1 would claim this was the original coding.
  return (rows[0]?.n ? Number(rows[0].n) : 1) + 1;
}

/**
 * Where a correction is allowed to book. The month the line belongs to when
 * that month is open; today when it is closed.
 *
 * Checked with a query rather than by posting and catching the trigger:
 * inside a transaction a failed statement poisons everything after it, so
 * "try it and see" would abort the correction it was meant to rescue.
 */
async function correctionDate(c: PoolClient, postedOn: string): Promise<string> {
  const { rows } = await c.query<{ status: string }>(
    `SELECT status FROM fiscal_periods
      WHERE period_start = date_trunc('month', $1::date)::date`,
    [postedOn],
  );
  if (rows[0]?.status !== "closed") return postedOn;
  const today = await c.query<{ d: string }>("SELECT CURRENT_DATE::text AS d");
  return today.rows[0]!.d;
}

/**
 * Net any job costs the old posting created back to zero with negative rows.
 * `cost_entries` is append-only, so this is the only correct shape — and the
 * reason migration 0050 had to widen its amount CHECK from `> 0` to `<> 0`.
 */
async function offsetCostEntries(
  c: PoolClient,
  scope: TenantScope,
  oldEntryId: string,
  undoEntryId: string,
  bookedOn: string,
): Promise<void> {
  const { rows } = await c.query<{
    id: string;
    job_id: string;
    cost_code: string;
    kind: string;
    amount_cents: string;
    memo: string;
  }>(
    `SELECT id, job_id, cost_code, kind, amount_cents, memo
       FROM cost_entries
      WHERE journal_entry_id = $1 AND reverses_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM cost_entries r WHERE r.reverses_id = cost_entries.id)`,
    [oldEntryId],
  );
  for (const r of rows) {
    await c.query(
      `INSERT INTO cost_entries (tenant_id, job_id, cost_code, kind, amount_cents,
         memo, source_type, journal_entry_id, occurred_on, created_by, reverses_id)
       VALUES ($1,$2,$3,$4,$5,$6,'reversal',$7,$8,$9,$10)`,
      [
        scope.tenantId, r.job_id, r.cost_code, r.kind, -Number(r.amount_cents),
        `Recoded: ${r.memo}`, undoEntryId, bookedOn, scope.uid, r.id,
      ],
    );
  }
}
