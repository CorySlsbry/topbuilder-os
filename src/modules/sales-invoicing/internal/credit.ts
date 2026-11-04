import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { getEntryLinesTx, postJournalEntryTx } from "@/modules/ledger";
import { InvoiceError } from "./store";

/**
 * The CPA pair, half one: credit memos, refunds, and invoice voids — the
 * ability to take a sale BACK, cleanly, in a ledger where posted rows are
 * immutable. Everything here is a NEW document + a reversing posting; nothing
 * ever edits history. That is what makes it auditable instead of erasable.
 *
 * The three shapes, and where they post (all seeded NAHB accounts):
 *
 *   credit memo → open invoice   DR 3490 concessions / CR 1210 AR
 *     ("we're knocking $150 off what you owe")
 *   credit memo → on account     DR 3490 concessions / CR 2010 deposits
 *     ("we owe YOU $150 — use it later or take it back")
 *   refund an on-account credit  DR 2010 deposits    / CR 1020 cash
 *     ("here's your $150 back" — check, cash, or a REAL Stripe refund)
 *   void an unpaid invoice       exact reversal of its original entry,
 *     dated TODAY (a closed January stays closed; the reversal is a
 *     February fact), status → 'void'
 *
 * Money-back-for-a-paid-invoice composes: on-account memo, then refund it.
 */

const AR = "1210";
const CASH = "1020";
const CONCESSIONS = "3490"; // Sales concessions and discounts (contra-revenue)
const DEPOSITS = "2010"; // Contract deposits — the customer-credit account

export interface CreditMemoRow {
  id: string;
  memoNo: number;
  customerId: string;
  customerName: string;
  invoiceId: string | null;
  invoiceNo: number | null;
  reason: string;
  amountCents: number;
  status: string;
  createdAt: string;
}

export async function createCreditMemo(
  scope: TenantScope,
  input: {
    customerId: string;
    invoiceId?: string;
    amountCents: number;
    reason: string;
    issuedOn: string;
  },
): Promise<{ id: string; memoNo: number }> {
  if (!input.reason.trim()) throw new InvoiceError(422, "reason_required");
  return withTenant(scope, async (c) => {
    let journalEntryId: string;
    let status: "open" | "applied";

    if (input.invoiceId) {
      // Applied to an invoice: reduces what is still collectible. Lock the
      // invoice — a credit racing a payment must see the true open balance.
      const { rows } = await c.query<{
        due_now_cents: string;
        paid_cents: string;
        status: string;
        invoice_no: string;
      }>(
        `SELECT due_now_cents, paid_cents, status, invoice_no
           FROM invoices WHERE id = $1 FOR UPDATE`,
        [input.invoiceId],
      );
      const inv = rows[0];
      if (!inv) throw new InvoiceError(404, "invoice_not_found");
      if (inv.status === "void") throw new InvoiceError(409, "invoice_void");
      const open = Number(inv.due_now_cents) - Number(inv.paid_cents);
      if (input.amountCents > open) {
        throw new InvoiceError(422, "credit_exceeds_open_balance");
      }

      journalEntryId = await postJournalEntryTx(c, scope, {
        occurredOn: input.issuedOn,
        memo: `Credit memo vs invoice #${inv.invoice_no}: ${input.reason}`,
        sourceType: "credit-memo",
        sourceId: input.invoiceId,
        lines: [
          { accountCode: CONCESSIONS, debitCents: input.amountCents },
          { accountCode: AR, creditCents: input.amountCents },
        ],
      });
      // due_now becomes "net still collectible"; paid >= due_now → settled.
      await c.query(
        `UPDATE invoices SET due_now_cents = due_now_cents - $2,
                status = CASE WHEN paid_cents >= due_now_cents - $2 THEN 'paid' ELSE status END
          WHERE id = $1`,
        [input.invoiceId, input.amountCents],
      );
      status = "applied";
    } else {
      // On account: the shop owes the customer. Sits in 2010 until used or
      // refunded.
      journalEntryId = await postJournalEntryTx(c, scope, {
        occurredOn: input.issuedOn,
        memo: `Customer credit: ${input.reason}`,
        sourceType: "credit-memo",
        lines: [
          { accountCode: CONCESSIONS, debitCents: input.amountCents },
          { accountCode: DEPOSITS, creditCents: input.amountCents },
        ],
      });
      status = "open";
    }

    const counter = await c.query<{ value: string }>(
      "SELECT app.next_counter('credit_memo_no') AS value",
    );
    const memoNo = Number(counter.rows[0]!.value);
    const ins = await c.query<{ id: string }>(
      `INSERT INTO credit_memos
         (tenant_id, customer_id, invoice_id, memo_no, reason, amount_cents,
          status, journal_entry_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        scope.tenantId,
        input.customerId,
        input.invoiceId ?? null,
        memoNo,
        input.reason.trim(),
        input.amountCents,
        status,
        journalEntryId,
        scope.uid,
      ],
    );
    return { id: ins.rows[0]!.id, memoNo };
  });
}

export async function listCreditMemos(scope: TenantScope): Promise<CreditMemoRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT cm.id, cm.memo_no AS "memoNo", cm.customer_id AS "customerId",
              cu.name AS "customerName", cm.invoice_id AS "invoiceId",
              i.invoice_no AS "invoiceNo", cm.reason,
              cm.amount_cents AS "amountCents", cm.status,
              cm.created_at::text AS "createdAt"
         FROM credit_memos cm
         JOIN customers cu ON cu.id = cm.customer_id
         LEFT JOIN invoices i ON i.id = cm.invoice_id
        ORDER BY cm.created_at DESC LIMIT 200`,
    );
    return (rows as (CreditMemoRow & { amountCents: string; invoiceNo: string | null })[]).map(
      (r) => ({
        ...r,
        amountCents: Number(r.amountCents),
        invoiceNo: r.invoiceNo === null ? null : Number(r.invoiceNo),
      }),
    );
  });
}

// ------------------------------------------------------------- refunds
async function stripeRefund(paymentIntentOrSession: string, amountCents: number): Promise<string> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new InvoiceError(503, "payments_not_configured");

  let intent = paymentIntentOrSession;
  if (intent.startsWith("cs_")) {
    // The webhook stores the checkout SESSION id; a refund needs the intent.
    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(intent)}`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    const session = (await res.json()) as { payment_intent?: string };
    if (!res.ok || !session.payment_intent) {
      throw new InvoiceError(502, "stripe_session_lookup_failed");
    }
    intent = session.payment_intent;
  }
  if (!intent.startsWith("pi_")) throw new InvoiceError(422, "payment_not_refundable");

  const res = await fetch("https://api.stripe.com/v1/refunds", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      // Stripe's own idempotency layer: a retried request returns the SAME
      // refund instead of minting a second one.
      "Idempotency-Key": `refund-${intent}-${amountCents}`,
    },
    body: new URLSearchParams({
      payment_intent: intent,
      amount: String(amountCents),
    }),
  });
  const refund = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok || !refund.id) {
    console.error("[stripe] refund failed:", refund.error?.message);
    throw new InvoiceError(502, "stripe_refund_failed");
  }
  return refund.id;
}

/**
 * Refund an OPEN on-account credit memo. 'stripe' method performs the real
 * money movement against the payment it came from; check/cash/ach records a
 * refund made outside the system (same honesty rule as bill payments).
 */
export async function refundCreditMemo(
  scope: TenantScope,
  input: {
    creditMemoId: string;
    method: "stripe" | "check" | "ach" | "cash";
    /** Required for stripe: which payment to send back. */
    paymentId?: string;
    reference?: string;
    refundedOn: string;
  },
): Promise<{ refundId: string }> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      amount_cents: string;
      status: string;
      customer_id: string;
    }>(`SELECT amount_cents, status, customer_id FROM credit_memos WHERE id = $1 FOR UPDATE`, [
      input.creditMemoId,
    ]);
    const memo = rows[0];
    if (!memo) throw new InvoiceError(404, "credit_memo_not_found");
    if (memo.status !== "open") throw new InvoiceError(409, "credit_memo_not_open");
    const amount = Number(memo.amount_cents);

    let stripeRefundId: string | null = null;
    if (input.method === "stripe") {
      if (!input.paymentId) throw new InvoiceError(422, "payment_id_required");
      const pay = await c.query<{ reference: string | null; amount_cents: string; method: string }>(
        `SELECT reference, amount_cents, method FROM payments WHERE id = $1`,
        [input.paymentId],
      );
      const p = pay.rows[0];
      if (!p || p.method !== "stripe" || !p.reference) {
        throw new InvoiceError(422, "payment_not_refundable");
      }
      if (amount > Number(p.amount_cents)) {
        throw new InvoiceError(422, "refund_exceeds_payment");
      }
      stripeRefundId = await stripeRefund(p.reference, amount);
    }

    const journalEntryId = await postJournalEntryTx(c, scope, {
      occurredOn: input.refundedOn,
      memo: `Refund of customer credit (${input.method})`,
      sourceType: "refund",
      sourceId: input.creditMemoId,
      lines: [
        { accountCode: DEPOSITS, debitCents: amount },
        { accountCode: CASH, creditCents: amount },
      ],
    });

    const ins = await c.query<{ id: string }>(
      `INSERT INTO refunds
         (tenant_id, credit_memo_id, payment_id, method, amount_cents,
          stripe_refund_id, status, journal_entry_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        scope.tenantId,
        input.creditMemoId,
        input.paymentId ?? null,
        input.method,
        amount,
        stripeRefundId,
        input.method === "stripe" ? "pending" : "recorded",
        journalEntryId,
        scope.uid,
      ],
    );
    await c.query(`UPDATE credit_memos SET status = 'refunded' WHERE id = $1`, [
      input.creditMemoId,
    ]);
    return { refundId: ins.rows[0]!.id };
  });
}

// ---------------------------------------------------------------- void
/**
 * Void an UNPAID invoice: post the exact reversal of its original entry,
 * dated today. Paid or partially-paid invoices refuse — money already moved;
 * that story belongs to a credit memo, which keeps the cash trail intact.
 */
export async function voidInvoice(
  scope: TenantScope,
  invoiceId: string,
  voidedOn: string,
): Promise<void> {
  await withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      status: string;
      paid_cents: string;
      journal_entry_id: string | null;
      invoice_no: string;
    }>(
      `SELECT status, paid_cents, journal_entry_id, invoice_no
         FROM invoices WHERE id = $1 FOR UPDATE`,
      [invoiceId],
    );
    const inv = rows[0];
    if (!inv) throw new InvoiceError(404, "invoice_not_found");
    if (inv.status === "void") throw new InvoiceError(409, "already_void");
    if (Number(inv.paid_cents) > 0) throw new InvoiceError(409, "invoice_has_payments");

    if (inv.journal_entry_id) {
      const lines = await getEntryLinesTx(c, inv.journal_entry_id);
      await postJournalEntryTx(c, scope, {
        occurredOn: voidedOn,
        memo: `VOID invoice #${inv.invoice_no}`,
        sourceType: "invoice-void",
        sourceId: invoiceId,
        // Spread first, THEN flip the sides: the job / customer / class
        // dimensions have to survive the reversal or the void balances the
        // company books while leaving the sale on that job's P&L.
        lines: lines.map((l) => ({
          ...l,
          debitCents: l.creditCents || undefined,
          creditCents: l.debitCents || undefined,
        })),
      });
    }
    await c.query(`UPDATE invoices SET status = 'void' WHERE id = $1`, [invoiceId]);
  });
}

// ------------------------------------------------------------ invoice list
export interface InvoiceListRow {
  id: string;
  invoiceNo: number;
  customerId: string;
  customerName: string;
  /** The job it bills, or the membership plan's memo when job-less. */
  about: string;
  issuedOn: string;
  totalCents: number;
  openCents: number;
  status: string;
}

/**
 * The office-wide invoice list. Until this existed invoices were only
 * reachable through their job, which made the void picker and the
 * applied-credit picker impossible to build — and made "find invoice #23"
 * a scavenger hunt. COALESCE resolves the customer for membership invoices
 * exactly as the CRM queries do.
 */
export async function listAllInvoices(
  scope: TenantScope,
  status?: string,
): Promise<InvoiceListRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT i.id, i.invoice_no AS "invoiceNo",
              cu.id AS "customerId", cu.name AS "customerName",
              COALESCE(j.name, i.memo, 'Membership') AS about,
              i.issued_on::text AS "issuedOn",
              (i.net_subtotal_cents + i.tax_cents)::bigint AS "totalCents",
              GREATEST(i.due_now_cents - i.paid_cents, 0)::bigint AS "openCents",
              i.status
         FROM invoices i
         LEFT JOIN jobs j ON j.id = i.job_id
         LEFT JOIN agreements ag ON ag.id = i.agreement_id
         JOIN customers cu ON cu.id = COALESCE(j.customer_id, ag.customer_id)
        WHERE ($1::text IS NULL OR i.status = $1)
        ORDER BY i.invoice_no DESC LIMIT 200`,
      [status ?? null],
    );
    return (rows as (InvoiceListRow & { totalCents: string; openCents: string })[]).map(
      (r) => ({ ...r, totalCents: Number(r.totalCents), openCents: Number(r.openCents) }),
    );
  });
}
