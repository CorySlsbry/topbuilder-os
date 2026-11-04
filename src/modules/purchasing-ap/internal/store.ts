import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { postJournalEntryTx, type EntryLineInput } from "@/modules/ledger";
import { DEFAULT_POSTING_ACCOUNTS } from "@/modules/field-ops";

export class ApError extends HttpError {
  constructor(status: 404 | 409 | 422 | 503, code: string) {
    super(status, code);
  }
}

const AP = DEFAULT_POSTING_ACCOUNTS.ap; // 2110
const CASH = DEFAULT_POSTING_ACCOUNTS.cash; // 1020
const JOB_COST = DEFAULT_POSTING_ACCOUNTS.jobCost; // 1430

// -------------------------------------------------------------- vendors
export interface VendorInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  is1099?: boolean;
  taxIdLast4?: string | null;
  defaultAccountCode?: string | null;
}

export interface VendorRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  is1099: boolean;
  taxIdLast4: string | null;
  defaultAccountCode: string | null;
}

export async function createVendor(scope: TenantScope, input: VendorInput): Promise<string> {
  return withTenant(scope, async (c) => {
    try {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO vendors (tenant_id, name, email, phone, is_1099, tax_id_last4, default_account_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          scope.tenantId,
          input.name.trim(),
          input.email ?? null,
          input.phone ?? null,
          input.is1099 ?? false,
          input.taxIdLast4 ?? null,
          input.defaultAccountCode ?? null,
        ],
      );
      return rows[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new ApError(409, "vendor_exists");
      }
      throw err;
    }
  });
}

export async function listVendors(scope: TenantScope): Promise<VendorRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT id, name, email, phone, is_1099 AS "is1099",
              tax_id_last4 AS "taxIdLast4", default_account_code AS "defaultAccountCode"
         FROM vendors ORDER BY name`,
    );
    return rows as VendorRow[];
  });
}

// ---------------------------------------------------------------- bills
export interface BillLineInput {
  amountCents: number;
  description?: string;
  jobId?: string;
  costCode?: string;
  costKind?: "labor" | "material" | "sub" | "equipment" | "other";
  accountCode?: string;
}

export interface BillInput {
  vendorId: string;
  issuedOn: string;
  dueOn?: string | null;
  billRef?: string;
  memo?: string;
  poId?: string | null;
  lines: BillLineInput[];
}

/**
 * Enter a bill: DR job-cost (1430 with dims, + a cost_entries row) or the
 * expense account per line / CR 2110 AP — one transaction, or nothing.
 */
export async function createBill(scope: TenantScope, input: BillInput): Promise<string> {
  return withTenant(scope, (c) => createBillTx(c, scope, input));
}

/** Same-transaction variant for the action gate (Documents agent). */
export async function createBillTx(
  c: PoolClient,
  scope: TenantScope,
  input: BillInput,
): Promise<string> {
  if (input.lines.length === 0) throw new ApError(422, "bill_needs_lines");
  const total = input.lines.reduce((t, l) => t + l.amountCents, 0);
  if (total <= 0) throw new ApError(422, "bill_total_not_positive");

  // The fallback for a job line that arrives without a code was the literal
  // string "4100" — a NAHB homebuilder account that meant nothing to a
  // trades shop and put every uncoded cost in the business in one bucket.
  // Fall back to the SHOP'S OWN first code instead, and only read it when a
  // line actually needs it (one query, and usually zero).
  let fallbackCode: string | null = null;
  if (input.lines.some((l) => l.jobId && !l.costCode)) {
    const { rows } = await c.query<{ code: string }>(
      "SELECT code FROM cost_codes WHERE is_active ORDER BY sort_order, code LIMIT 1",
    );
    fallbackCode = rows[0]?.code ?? null;
    // A shop with no cost codes at all is told to set them up rather than
    // handed a silent default it will find months later on a report.
    if (!fallbackCode) throw new ApError(422, "no_cost_codes_configured");
  }
  const codeFor = (l: { jobId?: string; costCode?: string }) =>
    l.jobId ? (l.costCode ?? fallbackCode!) : null;

  const glLines: EntryLineInput[] = [];
  for (const l of input.lines) {
    if (l.jobId) {
      glLines.push({
        accountCode: JOB_COST,
        debitCents: l.amountCents,
        jobId: l.jobId,
        // codeFor, not l.costCode — the LEDGER dimension and the cost_entries
        // row have to carry the same code or a P&L-by-cost-code and a job
        // report built from the same bill disagree with each other.
        costCode: codeFor(l) ?? undefined,
      });
    } else if (l.accountCode) {
      glLines.push({ accountCode: l.accountCode, debitCents: l.amountCents });
    } else {
      throw new ApError(422, "line_needs_job_or_account");
    }
  }
  glLines.push({ accountCode: AP, creditCents: total });

  const journalEntryId = await postJournalEntryTx(c, scope, {
    occurredOn: input.issuedOn,
    memo: input.memo || `Bill ${input.billRef ?? ""}`.trim(),
    sourceType: "ap-bill",
    lines: glLines,
  });

  let billId: string;
  try {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO bills (tenant_id, vendor_id, po_id, bill_ref, issued_on, due_on,
                          memo, total_cents, journal_entry_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        scope.tenantId,
        input.vendorId,
        input.poId ?? null,
        input.billRef ?? "",
        input.issuedOn,
        input.dueOn ?? null,
        input.memo ?? "",
        total,
        journalEntryId,
        scope.uid,
      ],
    );
    billId = rows[0]!.id;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new ApError(409, "po_already_billed");
    }
    throw err;
  }

  let lineNo = 1;
  for (const l of input.lines) {
    await c.query(
      `INSERT INTO bill_lines (tenant_id, bill_id, line_no, amount_cents, job_id,
                               cost_code, cost_kind, account_code, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        scope.tenantId,
        billId,
        lineNo++,
        l.amountCents,
        l.jobId ?? null,
        codeFor(l),
        l.jobId ? (l.costKind ?? "material") : null,
        l.jobId ? null : l.accountCode,
        l.description ?? "",
      ],
    );
    if (l.jobId) {
      await c.query(
        `INSERT INTO cost_entries (tenant_id, job_id, cost_code, kind, amount_cents,
           memo, source_type, journal_entry_id, occurred_on, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'bill',$7,$8,$9)`,
        [
          scope.tenantId,
          l.jobId,
          codeFor(l)!,
          l.costKind ?? "material",
          l.amountCents,
          l.description || (input.memo ?? "Bill"),
          journalEntryId,
          input.issuedOn,
          scope.uid,
        ],
      );
    }
  }

  // A billed PO is no longer a commitment (its cost is now on the books) —
  // mark it received if it wasn't already.
  if (input.poId) {
    await c.query(
      `UPDATE purchase_orders SET status = 'received' WHERE id = $1 AND status = 'open'`,
      [input.poId],
    );
  }
  return billId;
}

export interface BillRow {
  id: string;
  vendorId: string;
  vendorName: string;
  billRef: string;
  issuedOn: string;
  dueOn: string | null;
  memo: string;
  totalCents: number;
  paidCents: number;
  status: string;
}

export async function listBills(scope: TenantScope, status?: string): Promise<BillRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT b.id, b.vendor_id AS "vendorId", v.name AS "vendorName",
              b.bill_ref AS "billRef", b.issued_on::text AS "issuedOn",
              b.due_on::text AS "dueOn", b.memo,
              b.total_cents AS "totalCents", b.paid_cents AS "paidCents", b.status
         FROM bills b JOIN vendors v ON v.id = b.vendor_id
        WHERE ($1::text IS NULL OR b.status = $1)
        ORDER BY b.issued_on DESC, b.created_at DESC LIMIT 200`,
      [status ?? null],
    );
    return (rows as (BillRow & { totalCents: string; paidCents: string })[]).map((r) => ({
      ...r,
      totalCents: Number(r.totalCents),
      paidCents: Number(r.paidCents),
    }));
  });
}

export interface BillLineRow {
  lineNo: number;
  description: string;
  amountCents: number;
  jobId: string | null;
  jobName: string | null;
  costCode: string | null;
  accountCode: string | null;
}

export interface BillPaymentRow {
  id: string;
  paidOn: string;
  amountCents: number;
  method: string;
  reference: string | null;
  createdBy: string;
}

export interface BillDetail extends BillRow {
  vendorIs1099: boolean;
  lines: BillLineRow[];
  payments: BillPaymentRow[];
}

/**
 * One bill, with what it was for and everything paid against it so far.
 *
 * The payment HISTORY is the part that matters: partial payments are normal in
 * this trade (pay half on delivery, half on completion), and without a record
 * of what has already gone out, "what do I still owe" is guesswork — which is
 * exactly the question this screen exists to answer.
 */
export async function getBill(scope: TenantScope, billId: string): Promise<BillDetail | null> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT b.id, b.vendor_id AS "vendorId", v.name AS "vendorName",
              v.is_1099 AS "vendorIs1099",
              b.bill_ref AS "billRef", b.issued_on::text AS "issuedOn",
              b.due_on::text AS "dueOn", b.memo,
              b.total_cents AS "totalCents", b.paid_cents AS "paidCents", b.status
         FROM bills b JOIN vendors v ON v.id = b.vendor_id
        WHERE b.id = $1`,
      [billId],
    );
    const b = rows[0] as
      | (BillRow & { vendorIs1099: boolean; totalCents: string; paidCents: string })
      | undefined;
    if (!b) return null;

    const lines = await c.query(
      `SELECT bl.line_no AS "lineNo", bl.description, bl.amount_cents AS "amountCents",
              bl.job_id AS "jobId", j.name AS "jobName",
              bl.cost_code AS "costCode", bl.account_code AS "accountCode"
         FROM bill_lines bl
         LEFT JOIN jobs j ON j.id = bl.job_id
        WHERE bl.bill_id = $1
        ORDER BY bl.line_no`,
      [billId],
    );
    const payments = await c.query(
      `SELECT id, paid_on::text AS "paidOn", amount_cents AS "amountCents",
              method, reference, created_by AS "createdBy"
         FROM bill_payments WHERE bill_id = $1 ORDER BY paid_on, created_at`,
      [billId],
    );

    return {
      ...b,
      totalCents: Number(b.totalCents),
      paidCents: Number(b.paidCents),
      lines: (lines.rows as (BillLineRow & { amountCents: string })[]).map((l) => ({
        ...l,
        amountCents: Number(l.amountCents),
      })),
      payments: (payments.rows as (BillPaymentRow & { amountCents: string })[]).map((p) => ({
        ...p,
        amountCents: Number(p.amountCents),
      })),
    };
  });
}

// ------------------------------------------------------------- payments
export async function payBill(
  scope: TenantScope,
  billId: string,
  input: { paidOn: string; amountCents: number; method?: string; reference?: string },
): Promise<{ status: string; journalEntryId: string }> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      total_cents: string;
      paid_cents: string;
      status: string;
      memo: string;
    }>(`SELECT total_cents, paid_cents, status, memo FROM bills WHERE id = $1 FOR UPDATE`, [
      billId,
    ]);
    const bill = rows[0];
    if (!bill) throw new ApError(404, "bill_not_found");
    if (bill.status === "void") throw new ApError(409, "bill_void");
    if (bill.status === "paid") throw new ApError(409, "bill_already_paid");
    const remaining = Number(bill.total_cents) - Number(bill.paid_cents);
    if (input.amountCents <= 0 || input.amountCents > remaining) {
      throw new ApError(422, "amount_exceeds_remaining");
    }

    const journalEntryId = await postJournalEntryTx(c, scope, {
      occurredOn: input.paidOn,
      memo: `Bill payment: ${bill.memo}`,
      sourceType: "ap-payment",
      sourceId: billId,
      lines: [
        { accountCode: AP, debitCents: input.amountCents },
        { accountCode: CASH, creditCents: input.amountCents },
      ],
    });

    await c.query(
      `INSERT INTO bill_payments (tenant_id, bill_id, paid_on, amount_cents, method,
                                  reference, journal_entry_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        scope.tenantId,
        billId,
        input.paidOn,
        input.amountCents,
        input.method ?? "check",
        input.reference ?? null,
        journalEntryId,
        scope.uid,
      ],
    );
    const newPaid = Number(bill.paid_cents) + input.amountCents;
    const status = newPaid >= Number(bill.total_cents) ? "paid" : "partial";
    await c.query(`UPDATE bills SET paid_cents = $2, status = $3 WHERE id = $1`, [
      billId,
      newPaid,
      status,
    ]);
    return { status, journalEntryId };
  });
}

// ----------------------------------------------------------------- 1099
export interface Ten99Row {
  vendorId: string;
  vendorName: string;
  taxIdLast4: string | null;
  paidCents: number;
  /** IRS 1099-NEC threshold: $600. */
  reportable: boolean;
}

export async function get1099Summary(scope: TenantScope, year: number): Promise<Ten99Row[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT v.id AS "vendorId", v.name AS "vendorName",
              v.tax_id_last4 AS "taxIdLast4",
              COALESCE(SUM(p.amount_cents), 0)::bigint AS paid
         FROM vendors v
         LEFT JOIN bills b ON b.vendor_id = v.id
         LEFT JOIN bill_payments p ON p.bill_id = b.id
          AND p.paid_on >= make_date($1, 1, 1) AND p.paid_on < make_date($1 + 1, 1, 1)
        WHERE v.is_1099
        GROUP BY v.id, v.name, v.tax_id_last4
        ORDER BY v.name`,
      [year],
    );
    return (rows as { vendorId: string; vendorName: string; taxIdLast4: string | null; paid: string }[]).map(
      (r) => ({
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        taxIdLast4: r.taxIdLast4,
        paidCents: Number(r.paid),
        reportable: Number(r.paid) >= 60_000,
      }),
    );
  });
}

// -------------------------------------------- received POs needing bills
export interface ReceivedPo {
  id: string;
  jobId: string;
  jobNo: number;
  jobName: string;
  vendorName: string;
  description: string;
  amountCents: number;
}

export async function listReceivedPosWithoutBills(scope: TenantScope): Promise<ReceivedPo[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT po.id, po.job_id AS "jobId", j.job_no AS "jobNo", j.name AS "jobName",
              po.vendor_name AS "vendorName", po.description, po.amount_cents AS "amountCents"
         FROM purchase_orders po
         JOIN jobs j ON j.id = po.job_id
        WHERE po.status = 'received'
          AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.po_id = po.id)
        ORDER BY po.created_at`,
    );
    return (rows as (ReceivedPo & { amountCents: string; jobNo: string })[]).map((r) => ({
      ...r,
      jobNo: Number(r.jobNo),
      amountCents: Number(r.amountCents),
    }));
  });
}

/** Find-or-create a vendor by name (the received-PO -> bill draft path). */
export async function ensureVendorTx(
  c: PoolClient,
  scope: TenantScope,
  name: string,
): Promise<string> {
  const existing = await c.query<{ id: string }>(
    `SELECT id FROM vendors WHERE name = $1`,
    [name.trim()],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO vendors (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [scope.tenantId, name.trim()],
  );
  return rows[0]!.id;
}
