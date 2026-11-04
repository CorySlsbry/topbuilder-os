// Pure journal-entry validation — mirrors the DB invariants so bad input
// fails fast with a friendly error BEFORE a transaction is opened. The DB
// remains the last line of defense (deferred balance trigger, CHECKs).
import { HttpError } from "@/lib/http/errors";

export class LedgerError extends HttpError {
  constructor(code: string) {
    super(422, code);
  }
}

export interface EntryLineInput {
  accountCode: string;
  debitCents?: number;
  creditCents?: number;
  jobId?: string;
  costCode?: string;
  class?: string;
  customerId?: string;
  vendorId?: string;
}

export interface EntryInput {
  occurredOn: string; // ISO date (yyyy-mm-dd)
  memo?: string;
  sourceType?: string;
  sourceId?: string;
  reversalOf?: string;
  lines: EntryLineInput[];
}

function isCents(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/** Throws LedgerError unless the entry satisfies every ledger invariant. */
export function validateEntry(input: EntryInput): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn)) {
    throw new LedgerError("invalid_date");
  }
  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw new LedgerError("entry_needs_two_lines");
  }
  let debits = 0;
  let credits = 0;
  for (const line of input.lines) {
    if (!line.accountCode || typeof line.accountCode !== "string") {
      throw new LedgerError("line_missing_account");
    }
    const d = line.debitCents ?? 0;
    const c = line.creditCents ?? 0;
    if (!isCents(d) || !isCents(c)) {
      throw new LedgerError("amounts_must_be_nonnegative_integer_cents");
    }
    if ((d === 0) === (c === 0)) {
      // both zero or both nonzero — a line must be exactly one-sided
      throw new LedgerError("line_must_be_one_sided");
    }
    debits += d;
    credits += c;
  }
  if (debits !== credits) {
    throw new LedgerError("entry_unbalanced");
  }
}
