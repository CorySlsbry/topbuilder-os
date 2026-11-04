import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { postJournalEntryTx } from "@/modules/ledger";
import {
  buildPersonalReclass,
  suspectPersonal,
  type EntityType,
} from "@/modules/job-costing";
import { DEFAULT_OWNER_ACCOUNTS, DEFAULT_POSTING_ACCOUNTS } from "@/modules/field-ops";
import { tryMatch } from "./match";
import {
  detectFormat,
  fingerprint,
  normalizeDescription,
  parseCsvStatement,
  parseOfx,
  ruleMatcherFrom,
} from "./parse";

export class BankError extends HttpError {
  constructor(status: 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

// ------------------------------------------------------------- accounts
export interface BankAccount {
  id: string;
  name: string;
  glAccountCode: string;
  institution: string | null;
  last4: string | null;
  /** checking | savings | credit-card | line-of-credit | loan. */
  kind: string;
  /** True when this account's statements show a CHARGE as a positive number,
   *  which most card statements do and most checking statements do not. */
  chargesArePositive: boolean;
}

/**
 * Where a connected account posts, by what kind of account it is.
 *
 * ⛔ A CREDIT CARD IS A LIABILITY. Money leaving checking credits an asset;
 * a charge on a card credits a LIABILITY — it increases what the shop owes.
 * Defaulting every connected account to 1020 (cash) put card debt on the
 * balance sheet as negative cash, which is not a display bug: it is a wrong
 * balance sheet, and it is the one a bank and a surety read first.
 */
export const DEFAULT_GL_BY_KIND: Record<string, string> = {
  checking: "1020",
  savings: "1030",
  // 2150 is seeded by migration 0054 — the NAHB chart has no credit-card
  // account at all, and a default pointing at a code that does not exist
  // fails at POSTING time, on a screen somebody is halfway through.
  "credit-card": "2150",
  "line-of-credit": "2200",
  loan: "2700",
};

export async function createBankAccount(
  scope: TenantScope,
  input: {
    name: string;
    glAccountCode?: string;
    institution?: string;
    last4?: string;
    kind?: string;
    chargesArePositive?: boolean;
  },
): Promise<string> {
  const kind = input.kind ?? "checking";
  return withTenant(scope, async (c) => {
    const gl = input.glAccountCode ?? DEFAULT_GL_BY_KIND[kind] ?? "1020";
    // The account has to EXIST in this tenant's chart, or every posting
    // against it fails at runtime on a screen somebody is mid-way through.
    const exists = await c.query("SELECT 1 FROM chart_of_accounts WHERE code = $1", [gl]);
    if (exists.rowCount === 0) throw new BankError(422, `no_such_account:${gl}`);

    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO bank_accounts (tenant_id, name, gl_account_code, institution,
         last4, kind, charges_are_positive)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        scope.tenantId, input.name.trim(), gl,
        input.institution ?? null, input.last4 ?? null, kind,
        // Card statements usually print a purchase as a positive number.
        input.chargesArePositive ?? kind === "credit-card",
      ],
    );
    return rows[0]!.id;
  });
}

export async function listBankAccounts(scope: TenantScope): Promise<BankAccount[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<BankAccount>(
      `SELECT id, name, gl_account_code AS "glAccountCode", institution, last4,
              kind, charges_are_positive AS "chargesArePositive"
         FROM bank_accounts WHERE is_active ORDER BY kind, name`,
    );
    return rows;
  });
}

// ------------------------------------------------------------- import
export interface ImportSummary {
  importId: string;
  rowsTotal: number;
  rowsNew: number;
  rowsDuplicate: number;
  rowsSkipped: number;
  autoMatched: number;
}

/**
 * Import a statement file: parse → dedupe by fingerprint → auto-match against
 * the books → attach rule + personal suggestions. Nothing posts here; the
 * queue is what a human (or, later, the learning loop's promoted rules)
 * resolves. Re-importing the same file is a no-op by construction.
 */
export async function importStatement(
  scope: TenantScope,
  input: { bankAccountId: string; filename: string; content: string },
): Promise<ImportSummary> {
  const format = detectFormat(input.filename, input.content);
  if (!format) throw new BankError(422, "unrecognized_statement_format");
  const parsed = format === "csv" ? parseCsvStatement(input.content) : parseOfx(input.content);
  if (parsed.txns.length === 0) throw new BankError(422, "no_transactions_found");

  return withTenant(scope, async (c) => {
    const acct = await c.query<{ gl_account_code: string }>(
      "SELECT gl_account_code FROM bank_accounts WHERE id = $1",
      [input.bankAccountId],
    );
    if (acct.rowCount === 0) throw new BankError(404, "bank_account_not_found");
    // Matching is scoped to the account's own ledger code — see match.ts.
    const bankGl = acct.rows[0]!.gl_account_code;

    const imp = await c.query<{ id: string }>(
      `INSERT INTO statement_imports
         (tenant_id, bank_account_id, filename, format, rows_total, imported_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [scope.tenantId, input.bankAccountId, input.filename, format, parsed.txns.length, scope.uid],
    );
    const importId = imp.rows[0]!.id;

    const rules = await loadRules(c);
    let rowsNew = 0;
    let autoMatched = 0;

    for (const txn of parsed.txns) {
      const fp = fingerprint(input.bankAccountId, txn);
      const suggestion = suggestRule(rules, txn.description);
      const personal = txn.amountCents < 0 ? suspectPersonal(txn.description) : { suspect: false };

      const inserted = await c.query<{ id: string }>(
        `INSERT INTO bank_transactions
           (tenant_id, bank_account_id, import_id, posted_on, amount_cents,
            description, fingerprint, suggested_rule_id, personal_suspect, personal_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id, bank_account_id, fingerprint) DO NOTHING
         RETURNING id`,
        [
          scope.tenantId, input.bankAccountId, importId, txn.postedOn,
          txn.amountCents, txn.description, fp, suggestion?.id ?? null,
          personal.suspect, personal.reason ?? null,
        ],
      );
      if (inserted.rowCount === 0) continue; // duplicate — dedupe by design
      rowsNew += 1;

      // AUTO-MATCH: this bank line is already on the books — a payment
      // recorded when the customer paid, a bill payment written when the
      // check went out. Matching LINKS it and posts nothing.
      //
      // ⛔ Scoped to THIS account's ledger code, so a bill's cost entry
      // (which credits payables, not cash) can never match and the same
      // materials cannot be booked twice. See match.ts.
      const txnId = inserted.rows[0]!.id;
      const hit = await tryMatch(c, {
        txnId,
        bankGlCode: bankGl,
        amountCents: txn.amountCents,
        postedOn: txn.postedOn,
        uid: scope.uid,
      });
      if (hit) autoMatched += 1;
    }

    const rowsDuplicate = parsed.txns.length - rowsNew;
    await c.query(
      "UPDATE statement_imports SET rows_new = $2, rows_duplicate = $3 WHERE id = $1",
      [importId, rowsNew, rowsDuplicate],
    );
    return {
      importId,
      rowsTotal: parsed.txns.length,
      rowsNew,
      rowsDuplicate,
      rowsSkipped: parsed.skipped,
      autoMatched,
    };
  });
}

interface Rule {
  id: string;
  matcher: string;
  action: "expense" | "job-cost" | "personal";
  account_code: string | null;
  cost_kind: string | null;
}

async function loadRules(c: PoolClient): Promise<Rule[]> {
  const { rows } = await c.query<Rule>(
    "SELECT id, matcher, action, account_code, cost_kind FROM bank_rules ORDER BY length(matcher) DESC",
  );
  return rows;
}

function suggestRule(rules: Rule[], description: string): Rule | undefined {
  const norm = normalizeDescription(description);
  return rules.find((r) => norm.includes(r.matcher));
}

// ------------------------------------------------------------- the queue
export interface BankTxnRow {
  id: string;
  bankAccountId: string;
  postedOn: string;
  amountCents: number;
  description: string;
  status: string;
  personalSuspect: boolean;
  personalReason: string | null;
  suggestion: null | { ruleId: string; action: string; accountCode: string | null };
}

export async function listBankTxns(
  scope: TenantScope,
  status?: string,
): Promise<BankTxnRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<BankTxnRow & { rule_action: string | null; rule_account: string | null }>(
      `SELECT t.id, t.bank_account_id AS "bankAccountId", t.posted_on::text AS "postedOn",
              t.amount_cents AS "amountCents", t.description, t.status,
              t.personal_suspect AS "personalSuspect", t.personal_reason AS "personalReason",
              t.suggested_rule_id AS "ruleId", r.action AS rule_action, r.account_code AS rule_account
         FROM bank_transactions t
         LEFT JOIN bank_rules r ON r.id = t.suggested_rule_id
        WHERE ($1::text IS NULL OR t.status = $1)
        ORDER BY t.posted_on DESC, t.created_at DESC
        LIMIT 500`,
      [status ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      bankAccountId: r.bankAccountId,
      postedOn: r.postedOn,
      amountCents: Number(r.amountCents),
      description: r.description,
      status: r.status,
      personalSuspect: r.personalSuspect,
      personalReason: r.personalReason,
      suggestion:
        (r as unknown as { ruleId: string | null }).ruleId && r.rule_action
          ? {
              ruleId: (r as unknown as { ruleId: string }).ruleId,
              action: r.rule_action,
              accountCode: r.rule_account,
            }
          : null,
    }));
  });
}

// -------------------------------------------------- what's already posted
export interface PostedTxnRow {
  id: string;
  postedOn: string;
  amountCents: number;
  description: string;
  status: string;
  bankAccountName: string;
  /** The account the money actually landed in — read from the LEDGER. */
  codedToCode: string | null;
  codedToName: string | null;
  jobId: string | null;
  jobNo: number | null;
  jobName: string | null;
  costCode: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  /** >1 means somebody has already corrected this line. */
  answerCount: number;
}

/**
 * Everything already answered, and what it was answered WITH.
 *
 * The coding is read back out of the journal rather than out of a status
 * column, because the journal is the book of record: if a screen and the
 * ledger ever disagree about where a dollar went, the screen is the one
 * that is lying. Reading the ledger makes that class of drift impossible
 * instead of merely unlikely.
 *
 * The LATERAL picks the first line that is NOT the bank account itself —
 * i.e. the other side of the entry, which is the category a person would
 * name if you asked them where the money went.
 */
export async function listPostedTxns(
  scope: TenantScope,
  opts: { bankAccountId?: string; q?: string; limit?: number } = {},
): Promise<PostedTxnRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      id: string;
      postedOn: string;
      amount_cents: string;
      description: string;
      status: string;
      bank_account_name: string;
      coded_code: string | null;
      coded_name: string | null;
      job_id: string | null;
      job_no: string | null;
      job_name: string | null;
      cost_code: string | null;
      resolved_by: string | null;
      resolved_at: string | null;
      answers: string;
    }>(
      `SELECT t.id, t.posted_on::text AS "postedOn", t.amount_cents,
              t.description, t.status,
              ba.name AS bank_account_name,
              o.code AS coded_code, o.acct_name AS coded_name,
              o.job_id, j.job_no, j.name AS job_name, o.cost_code,
              t.resolved_by, t.resolved_at::text AS resolved_at,
              (SELECT COUNT(*) FROM bank_txn_resolutions r WHERE r.txn_id = t.id) AS answers
         FROM bank_transactions t
         JOIN bank_accounts ba ON ba.id = t.bank_account_id
         LEFT JOIN LATERAL (
           SELECT a.code, a.name AS acct_name, l.job_id, l.cost_code
             FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
            WHERE l.entry_id = t.journal_entry_id
              AND a.code <> ba.gl_account_code
            ORDER BY l.line_no
            LIMIT 1
         ) o ON true
         LEFT JOIN jobs j ON j.id = o.job_id
        WHERE t.status <> 'pending'
          AND ($1::uuid IS NULL OR t.bank_account_id = $1)
          AND ($2::text IS NULL OR t.description ILIKE '%' || $2 || '%')
        ORDER BY t.posted_on DESC, t.created_at DESC
        LIMIT $3`,
      [opts.bankAccountId ?? null, opts.q?.trim() || null, Math.min(opts.limit ?? 100, 500)],
    );
    return rows.map((r) => ({
      id: r.id,
      postedOn: r.postedOn,
      amountCents: Number(r.amount_cents),
      description: r.description,
      status: r.status,
      bankAccountName: r.bank_account_name,
      codedToCode: r.coded_code,
      codedToName: r.coded_name,
      jobId: r.job_id,
      jobNo: r.job_no === null ? null : Number(r.job_no),
      jobName: r.job_name,
      costCode: r.cost_code,
      resolvedBy: r.resolved_by,
      resolvedAt: r.resolved_at,
      answerCount: Number(r.answers),
    }));
  });
}

/** The correction trail for one line: who answered, with what, and why. */
export interface ResolutionRow {
  seq: number;
  action: string;
  accountCode: string | null;
  costCode: string | null;
  reason: string;
  resolvedBy: string;
  resolvedAt: string;
}

export async function listResolutions(
  scope: TenantScope,
  txnId: string,
): Promise<ResolutionRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<ResolutionRow>(
      `SELECT seq, action, account_code AS "accountCode", cost_code AS "costCode",
              reason, resolved_by AS "resolvedBy", resolved_at::text AS "resolvedAt"
         FROM bank_txn_resolutions WHERE txn_id = $1 ORDER BY seq`,
      [txnId],
    );
    return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
  });
}

// ------------------------------------------------------------- resolve
/** One part of a split. Each part is a whole answer in miniature. */
export type SplitLine =
  | { type: "expense"; accountCode: string; amountCents: number; memo?: string }
  | {
      type: "job-cost";
      jobId: string;
      costCode: string;
      kind: "labor" | "material" | "sub" | "equipment" | "other";
      amountCents: number;
      memo?: string;
    };

export type ResolveAction =
  | { type: "expense"; accountCode: string; remember?: boolean }
  | { type: "job-cost"; jobId: string; costCode: string; kind: "labor" | "material" | "sub" | "equipment" | "other"; remember?: boolean }
  | { type: "personal" }
  | { type: "exclude" }
  /**
   * One bank line, several answers.
   *
   * A $4,120 charge from the supply house covering three jobs is not one
   * categorization — it is three, and the alternatives were both wrong:
   * code the whole thing to one job (wrong on two) or to an overhead
   * account (wrong on all three and invisible on every job report).
   *
   * The parts MUST sum to the transaction exactly. Not "close enough" — a
   * split that does not add up puts the difference somewhere nobody chose.
   */
  | { type: "split"; lines: SplitLine[] }
  /**
   * Money moving between the shop's OWN accounts.
   *
   * ⛔ THE MOMENT THERE ARE TWO ACCOUNTS, THIS IS NOT OPTIONAL. Paying the
   * credit card from checking shows up on BOTH feeds. Without a transfer
   * answer it becomes an expense on one side and income on the other, and
   * the P&L is wrong by twice the payment — in the direction that makes the
   * shop look MORE profitable, which is the direction nobody questions.
   *
   * `otherTxnId` is the matching line on the other account when it has also
   * imported. Supplying it links the two so neither can be answered twice
   * and a later reader can see they are one movement.
   */
  | { type: "transfer"; otherAccountId: string; otherTxnId?: string };

/**
 * Resolve one queue item. Every path that MOVES MONEY posts a balanced GL
 * entry in the same transaction as the status change. "remember" upserts a
 * learning rule so the same merchant auto-suggests next time — suggestions
 * only; the human gate stays.
 */
export async function resolveBankTxn(
  scope: TenantScope,
  txnId: string,
  action: ResolveAction,
): Promise<{ status: string; journalEntryId: string | null }> {
  return withTenant(scope, (c) => resolveBankTxnTx(c, scope, txnId, action));
}

/**
 * Same-transaction variant: runs on an already-scoped client so callers
 * (the agent action gate) can commit the categorization atomically with
 * their own bookkeeping.
 */
export async function resolveBankTxnTx(
  c: PoolClient,
  scope: TenantScope,
  txnId: string,
  action: ResolveAction,
): Promise<{ status: string; journalEntryId: string | null }> {
  {
    const t = await c.query<{
      id: string;
      bank_account_id: string;
      posted_on: string;
      amount_cents: string;
      description: string;
      status: string;
    }>(
      // posted_on::text — node-postgres returns date columns as JS Dates,
      // but the ledger validates entry dates as YYYY-MM-DD strings.
      //
      // FOR UPDATE because everything below branches on `status` and then
      // writes it. Two resolves of the same line — an agent card approved
      // while someone categorizes it by hand — would both read 'pending',
      // both post a journal entry, and the second UPDATE would quietly
      // overwrite the first's journal_entry_id, orphaning a real posting in
      // the ledger with nothing pointing at it.
      `SELECT id, bank_account_id, posted_on::text AS posted_on,
              amount_cents, description, status
         FROM bank_transactions WHERE id = $1 FOR UPDATE`,
      [txnId],
    );
    const txn = t.rows[0];
    if (!txn) throw new BankError(404, "txn_not_found");
    if (txn.status !== "pending") throw new BankError(422, "txn_already_resolved");
    const amount = Number(txn.amount_cents);

    const acct = await c.query<{ gl_account_code: string }>(
      "SELECT gl_account_code FROM bank_accounts WHERE id = $1",
      [txn.bank_account_id],
    );
    const bankGl = acct.rows[0]!.gl_account_code;
    const postedOn = txn.posted_on;

    const { status, journalEntryId } = await postResolutionTx(
      c,
      scope,
      { id: txn.id, description: txn.description, amountCents: amount, postedOn },
      action,
      bankGl,
      postedOn,
    );

    await c.query(
      `UPDATE bank_transactions
          SET status = $2, journal_entry_id = COALESCE($3, journal_entry_id),
              resolved_by = $4, resolved_at = now()
        WHERE id = $1`,
      [txnId, status, journalEntryId, scope.uid],
    );
    await recordResolution(c, scope, txnId, 1, action, journalEntryId, null, "");
    return { status, journalEntryId };
  }
}

/** The four shapes a bank line can be answered with, and where each posts. */
export interface ResolvableTxn {
  id: string;
  description: string;
  /** SIGNED: negative is money out. */
  amountCents: number;
  postedOn: string;
}

/**
 * Turn one answer into ledger postings. Extracted so that CORRECTING a line
 * runs the identical code that categorized it in the first place — if these
 * were two copies, the correction path would be the one that drifts, and it
 * is the path nobody looks at until an auditor does.
 *
 * `bookOn` is the date the postings carry. It is normally the bank line's own
 * date, but a correction to a line in a CLOSED month books today instead —
 * a closed January stays closed.
 */
export async function postResolutionTx(
  c: PoolClient,
  scope: TenantScope,
  txn: ResolvableTxn,
  action: ResolveAction,
  bankGl: string,
  bookOn: string,
): Promise<{ status: string; journalEntryId: string | null }> {
  const amount = txn.amountCents;
  const abs = Math.abs(amount);

  if (action.type === "exclude") {
    return { status: "excluded", journalEntryId: null };
  }

  if (action.type === "transfer") {
    const other = await c.query<{ gl_account_code: string; name: string }>(
      "SELECT gl_account_code, name FROM bank_accounts WHERE id = $1",
      [action.otherAccountId],
    );
    if (other.rowCount === 0) throw new BankError(404, "other_account_not_found");
    const otherGl = other.rows[0]!.gl_account_code;
    if (otherGl === bankGl) throw new BankError(422, "transfer_to_same_ledger_account");

    // Money OUT of this account is money IN to the other one. Nothing hits
    // an income or expense account, which is the whole point: a transfer
    // moves the shop's money around, it does not change what the shop is
    // worth.
    const journalEntryId = await postJournalEntryTx(c, scope, {
      occurredOn: bookOn,
      memo: `Transfer: ${txn.description} (${other.rows[0]!.name})`,
      sourceType: "bank-transfer",
      sourceId: txn.id,
      lines:
        amount < 0
          ? [
              { accountCode: otherGl, debitCents: abs },
              { accountCode: bankGl, creditCents: abs },
            ]
          : [
              { accountCode: bankGl, debitCents: abs },
              { accountCode: otherGl, creditCents: abs },
            ],
    });

    // Link the two sides. The other line is marked resolved WITHOUT its own
    // posting — one movement, one entry. Answering it separately would
    // double the transfer, which is exactly the bug this feature exists to
    // prevent.
    if (action.otherTxnId) {
      const linked = await c.query(
        `UPDATE bank_transactions
            SET status = 'transfer', journal_entry_id = $2, transfer_pair_id = $3,
                resolved_by = $4, resolved_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [action.otherTxnId, journalEntryId, txn.id, scope.uid],
      );
      if (linked.rowCount === 0) throw new BankError(409, "other_side_already_answered");
    }
    return { status: "transfer", journalEntryId };
  }

  if (action.type === "split") {
    if (action.lines.length < 2) throw new BankError(422, "split_needs_two_or_more_lines");
    const total = action.lines.reduce((t, l) => t + l.amountCents, 0);
    // ⛔ EXACT, not "close enough". A split that does not add up puts the
    // difference somewhere nobody chose — and it would balance anyway,
    // because the bank side is one figure, so nothing downstream would
    // catch it.
    if (total !== abs) throw new BankError(422, `split_must_total_${abs}_not_${total}`);
    if (action.lines.some((l) => l.amountCents <= 0)) {
      throw new BankError(422, "split_lines_must_be_positive");
    }
    if (amount >= 0 && action.lines.some((l) => l.type === "job-cost")) {
      throw new BankError(422, "job_cost_requires_money_out");
    }

    const glLines = action.lines.map((l) =>
      l.type === "job-cost"
        ? {
            accountCode: DEFAULT_POSTING_ACCOUNTS.jobCost,
            debitCents: l.amountCents,
            jobId: l.jobId,
            costCode: l.costCode,
          }
        : { accountCode: l.accountCode, debitCents: l.amountCents },
    );
    // Money in flips every side: the bank is debited and each part credited.
    const entryLines =
      amount < 0
        ? [...glLines, { accountCode: bankGl, creditCents: abs }]
        : [
            { accountCode: bankGl, debitCents: abs },
            ...glLines.map((l) => ({ ...l, debitCents: undefined, creditCents: l.debitCents })),
          ];

    const journalEntryId = await postJournalEntryTx(c, scope, {
      occurredOn: bookOn,
      memo: `${txn.description} (split ${action.lines.length} ways)`,
      sourceType: "bank-categorize",
      sourceId: txn.id,
      lines: entryLines,
    });

    for (const l of action.lines) {
      if (l.type !== "job-cost") continue;
      await c.query(
        `INSERT INTO cost_entries (tenant_id, job_id, cost_code, kind, amount_cents,
           memo, source_type, journal_entry_id, occurred_on, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'bill',$7,$8,$9)`,
        [
          scope.tenantId, l.jobId, l.costCode, l.kind, l.amountCents,
          l.memo || txn.description, journalEntryId, bookOn, scope.uid,
        ],
      );
    }
    // No learning rule from a split: "this merchant is always three jobs"
    // is not a rule, and the jobs will be different ones next time.
    return { status: "categorized", journalEntryId };
  }

  if (action.type === "personal") {
    if (amount >= 0) throw new BankError(422, "personal_requires_money_out");
    const entity = await c.query<{ entity_type: EntityType }>(
      "SELECT entity_type FROM tenants WHERE id = app.current_tenant()",
    );
    const entry = buildPersonalReclass({
      entityType: entity.rows[0]?.entity_type ?? "sole-prop",
      amountCents: abs,
      occurredOn: bookOn,
      cashAccountCode: bankGl,
      drawsAccountCode: DEFAULT_OWNER_ACCOUNTS.drawsAccountCode,
      dueFromOwnerAccountCode: DEFAULT_OWNER_ACCOUNTS.dueFromOwnerAccountCode,
      memo: `Personal: ${txn.description}`,
      sourceId: txn.id,
    });
    return { status: "personal", journalEntryId: await postJournalEntryTx(c, scope, entry) };
  }

  if (action.type === "expense") {
    const journalEntryId = await postJournalEntryTx(c, scope, {
      occurredOn: bookOn,
      memo: txn.description,
      sourceType: "bank-categorize",
      sourceId: txn.id,
      lines:
        amount < 0
          ? [
              { accountCode: action.accountCode, debitCents: abs },
              { accountCode: bankGl, creditCents: abs },
            ]
          : [
              { accountCode: bankGl, debitCents: abs },
              { accountCode: action.accountCode, creditCents: abs },
            ],
    });
    if (action.remember) {
      await upsertRule(c, scope, txn.description, "expense", action.accountCode);
    }
    return { status: "categorized", journalEntryId };
  }

  // job-cost: money-out only; posts DR job cost / CR bank + a cost_entry row
  if (amount >= 0) throw new BankError(422, "job_cost_requires_money_out");
  const journalEntryId = await postJournalEntryTx(c, scope, {
    occurredOn: bookOn,
    memo: txn.description,
    sourceType: "bank-categorize",
    sourceId: txn.id,
    lines: [
      {
        accountCode: DEFAULT_POSTING_ACCOUNTS.jobCost,
        debitCents: abs,
        jobId: action.jobId,
        costCode: action.costCode,
      },
      { accountCode: bankGl, creditCents: abs },
    ],
  });
  await c.query(
    `INSERT INTO cost_entries (tenant_id, job_id, cost_code, kind, amount_cents,
       memo, source_type, journal_entry_id, occurred_on, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'bill',$7,$8,$9)`,
    [
      scope.tenantId, action.jobId, action.costCode, action.kind, abs,
      txn.description, journalEntryId, bookOn, scope.uid,
    ],
  );
  if (action.remember) {
    await upsertRule(c, scope, txn.description, "job-cost", null, action.kind);
  }
  return { status: "categorized", journalEntryId };
}

/**
 * Append one row to the correction log. The LEDGER already records what
 * changed and cannot be rewritten; this records who decided and why, which
 * the ledger has no column for.
 */
export async function recordResolution(
  c: PoolClient,
  scope: TenantScope,
  txnId: string,
  seq: number,
  action: ResolveAction | { type: "unmatch" },
  journalEntryId: string | null,
  undoEntryId: string | null,
  reason: string,
): Promise<void> {
  // A split is ONE decision recorded as several rows: they share a `seq` and
  // are told apart by `split_no`, so the log reads back as the single answer
  // somebody actually gave.
  if (action.type === "split") {
    let n = 0;
    for (const l of action.lines) {
      await c.query(
        `INSERT INTO bank_txn_resolutions
           (tenant_id, txn_id, seq, split_no, action, account_code, job_id,
            cost_code, cost_kind, amount_cents, journal_entry_id, undo_entry_id,
            reason, resolved_by)
         VALUES ($1,$2,$3,$4,'split',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          scope.tenantId, txnId, seq, n++,
          l.type === "expense" ? l.accountCode : null,
          l.type === "job-cost" ? l.jobId : null,
          l.type === "job-cost" ? l.costCode : null,
          l.type === "job-cost" ? l.kind : null,
          l.amountCents,
          journalEntryId, undoEntryId, reason, scope.uid,
        ],
      );
    }
    return;
  }

  const jobCost = action.type === "job-cost" ? action : null;
  await c.query(
    `INSERT INTO bank_txn_resolutions
       (tenant_id, txn_id, seq, action, account_code, job_id, cost_code,
        cost_kind, journal_entry_id, undo_entry_id, reason, resolved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      scope.tenantId, txnId, seq, action.type,
      action.type === "expense" ? action.accountCode : null,
      jobCost?.jobId ?? null,
      jobCost?.costCode ?? null,
      jobCost?.kind ?? null,
      journalEntryId, undoEntryId, reason, scope.uid,
    ],
  );
}

async function upsertRule(
  c: PoolClient,
  scope: TenantScope,
  description: string,
  action: "expense" | "job-cost",
  accountCode: string | null,
  costKind?: string,
): Promise<void> {
  const matcher = ruleMatcherFrom(description);
  if (matcher.length < 3) return; // too generic to be a safe rule
  await c.query(
    `INSERT INTO bank_rules (tenant_id, matcher, action, account_code, cost_kind, hit_count, created_from)
     VALUES ($1,$2,$3,$4,$5,1,'learned')
     ON CONFLICT (tenant_id, matcher) DO UPDATE SET
       action = EXCLUDED.action, account_code = EXCLUDED.account_code,
       cost_kind = EXCLUDED.cost_kind, hit_count = bank_rules.hit_count + 1,
       updated_at = now()`,
    [scope.tenantId, matcher, action, accountCode, costKind ?? null],
  );
}

// ------------------------------------------------------------- reconcile
export interface ReconcileResult {
  txnCount: number;
  bookBalanceCents: number;
  statementEndingCents: number;
  differenceCents: number;
  /** True when more than one bank account posts to the same GL code, which
   *  makes a single-account book balance impossible to isolate. */
  sharedGlAccount: boolean;
}

/**
 * Reconcile — and PROVE it, against the number the bank printed.
 *
 * ⛔ "RECONCILED" USED TO MEAN "THE QUEUE IS EMPTY". That is necessary and
 * nowhere near sufficient. A statement line that never imported, a duplicate
 * the fingerprint dedupe missed, a payment somebody keyed in that never
 * actually happened — none of those leave anything in the review queue, and
 * every one of them means the books do not match the bank.
 *
 * The only check that catches them is the one every bookkeeper already knows:
 * does the ledger balance of the cash account equal the STATEMENT ENDING
 * BALANCE? So that number is now required, the difference is computed and
 * stored, and a non-zero difference cannot be locked away without somebody
 * writing down why.
 */
export async function reconcile(
  scope: TenantScope,
  bankAccountId: string,
  periodEnd: string,
  statementEndingCents: number,
  differenceReason = "",
): Promise<ReconcileResult> {
  return withTenant(scope, async (c) => {
    const pending = await c.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM bank_transactions
        WHERE bank_account_id = $1 AND posted_on <= $2 AND status = 'pending'`,
      [bankAccountId, periodEnd],
    );
    const pendingCount = Number(pending.rows[0]!.n);
    if (pendingCount > 0) {
      throw new BankError(422, `queue_not_clear:${pendingCount}`);
    }

    const acct = await c.query<{ gl_account_code: string }>(
      "SELECT gl_account_code FROM bank_accounts WHERE id = $1",
      [bankAccountId],
    );
    if (acct.rowCount === 0) throw new BankError(404, "bank_account_not_found");
    const gl = acct.rows[0]!.gl_account_code;

    // Two accounts posting to one GL code cannot be reconciled separately —
    // the ledger cannot tell them apart, so neither can this. Reported rather
    // than silently reconciling one against both.
    const sharing = await c.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM bank_accounts WHERE gl_account_code = $1",
      [gl],
    );
    const sharedGlAccount = Number(sharing.rows[0]!.n) > 1;

    const book = await c.query<{ net: string }>(
      `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::text AS net
         FROM journal_lines l
         JOIN chart_of_accounts a ON a.id = l.account_id
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE a.code = $1 AND e.occurred_on <= $2`,
      [gl, periodEnd],
    );
    const bookBalanceCents = Number(book.rows[0]!.net);
    const differenceCents = bookBalanceCents - statementEndingCents;

    if (differenceCents !== 0 && !differenceReason.trim()) {
      throw new BankError(422, `out_of_balance:${differenceCents}`);
    }

    const counted = await c.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM bank_transactions
        WHERE bank_account_id = $1 AND posted_on <= $2 AND status <> 'excluded'`,
      [bankAccountId, periodEnd],
    );
    const txnCount = Number(counted.rows[0]!.n);

    try {
      await c.query(
        `INSERT INTO reconciliations (tenant_id, bank_account_id, period_end, txn_count,
           statement_ending_cents, book_balance_cents, difference_cents,
           difference_reason, reconciled_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          scope.tenantId, bankAccountId, periodEnd, txnCount,
          statementEndingCents, bookBalanceCents, differenceCents,
          differenceReason.trim(), scope.uid,
        ],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new BankError(409, "period_already_reconciled");
      }
      throw err;
    }

    // The LIR event only fires on a TRUE reconciliation. A period locked with
    // a noted difference is an honest record, not a clean loop, and counting
    // it would make the retention metric flatter.
    if (differenceCents === 0) {
      await c.query(
        `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid)
         VALUES ($1, 'reconciled_clean', 'bank_account', $2, $3)`,
        [scope.tenantId, bankAccountId, scope.uid],
      );
    }

    return {
      txnCount,
      bookBalanceCents,
      statementEndingCents,
      differenceCents,
      sharedGlAccount,
    };
  });
}

/** What the books say this account holds right now — so the screen can show
 *  the difference BEFORE somebody commits to locking the period. */
export async function getBookBalance(
  scope: TenantScope,
  bankAccountId: string,
  asOf: string,
): Promise<{ bookBalanceCents: number; sharedGlAccount: boolean }> {
  return withTenant(scope, async (c) => {
    const acct = await c.query<{ gl_account_code: string }>(
      "SELECT gl_account_code FROM bank_accounts WHERE id = $1",
      [bankAccountId],
    );
    if (acct.rowCount === 0) throw new BankError(404, "bank_account_not_found");
    const gl = acct.rows[0]!.gl_account_code;
    const [book, sharing] = await Promise.all([
      c.query<{ net: string }>(
        `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::text AS net
           FROM journal_lines l
           JOIN chart_of_accounts a ON a.id = l.account_id
           JOIN journal_entries e ON e.id = l.entry_id
          WHERE a.code = $1 AND e.occurred_on <= $2`,
        [gl, asOf],
      ),
      c.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM bank_accounts WHERE gl_account_code = $1",
        [gl],
      ),
    ]);
    return {
      bookBalanceCents: Number(book.rows[0]!.net),
      sharedGlAccount: Number(sharing.rows[0]!.n) > 1,
    };
  });
}
