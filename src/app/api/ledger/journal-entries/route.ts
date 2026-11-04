import { NextResponse } from "next/server";
import { z } from "zod";
import { postJournalEntry, validateEntry } from "@/modules/ledger";
import { route } from "@/lib/http/route";
import { idempotent } from "@/lib/http/idempotency";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const Line = z
  .object({
    accountCode: z.string().trim().min(1).max(20),
    debitCents: z.number().int().positive().optional(),
    creditCents: z.number().int().positive().optional(),
    jobId: z.string().uuid().optional(),
    memo: z.string().max(200).optional(),
  })
  .refine((l) => (l.debitCents === undefined) !== (l.creditCents === undefined), {
    message: "exactly one side",
  });

const Body = z.object({
  occurredOn: z.string().regex(DATE),
  memo: z.string().trim().min(1).max(300),
  lines: z.array(Line).min(2).max(40),
  /**
   * Accrual convenience: post the mirror entry dated this day (usually the
   * 1st of next month). The pair is two REAL entries — no special state, no
   * magic, exactly what a CPA writes by hand in QBO, minus the second trip.
   */
  autoReverseOn: z.string().regex(DATE).optional(),
});

/**
 * The CPA pair, half two: MANUAL adjusting entries.
 *
 * Until now every journal entry was machine-posted from an event; the CPA's
 * year-end work (depreciation, accruals, reclasses) had nowhere to live.
 * This is the bookkeeper's pen — owner/admin/bookkeeper, financials wall,
 * second factor, and idempotency-keyed because it IS money.
 *
 * Balance is checked here for a friendly 422; the ledger's DB trigger
 * enforces it regardless (defense in depth, not trust in the route). Closed
 * periods refuse at the trigger, exactly as they do for machine postings —
 * the CPA adjusts a closed year through a dated entry in the OPEN period,
 * the same rule QBO enforces with its close-date password.
 */
export const POST = route(
  idempotent(
    "ledger.journal-entries",
    {
      scope: {
        roles: ["owner", "admin", "bookkeeper"],
        departments: ["financials"],
        aal2: true,
      },
      require: true,
    },
    async (body, scope) => {
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");
      const { occurredOn, memo, lines, autoReverseOn } = parsed.data;

      if (autoReverseOn && autoReverseOn <= occurredOn) {
        return errorResponse(422, "reversal_must_follow_entry");
      }

      const entry = {
        occurredOn,
        memo: `Adjusting entry: ${memo}`,
        sourceType: "manual" as const,
        lines,
      };
      // Throws LedgerError (422 with the specific invariant) on bad input —
      // fail fast here so the reversal below can't post against a bad base.
      validateEntry(entry);

      const journalEntryId = await postJournalEntry(scope, entry);

      let reversalEntryId: string | null = null;
      if (autoReverseOn) {
        reversalEntryId = await postJournalEntry(scope, {
          occurredOn: autoReverseOn,
          memo: `Auto-reversal of: ${memo}`,
          sourceType: "manual" as const,
          lines: lines.map((l) => ({
            accountCode: l.accountCode,
            debitCents: l.creditCents,
            creditCents: l.debitCents,
            jobId: l.jobId,
          })),
        });
      }
      return NextResponse.json({ journalEntryId, reversalEntryId }, { status: 201 });
    },
  ),
);
