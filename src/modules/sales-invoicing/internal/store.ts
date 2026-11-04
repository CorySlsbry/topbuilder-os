import "server-only";
import { mulDivHalfUp } from "@/lib/money/cents";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { postJournalEntryTx } from "@/modules/ledger";
import {
  computeTax,
  postInvoiceIssued,
  postPaymentReceived,
  splitRetainage,
  type PostingAccounts,
  type TaxProfile,
} from "@/modules/job-costing";
import { HttpError } from "@/lib/http/errors";
import { DEFAULT_POSTING_ACCOUNTS } from "@/modules/field-ops";
import type { PoolClient } from "pg";

/** Sales concessions and discounts — contra-revenue, seeded in the NAHB
 *  chart. The same account credit memos use, because a member discount and a
 *  credit memo are the same fact: revenue given back. */
const CONCESSIONS = "3490";

export class InvoiceError extends HttpError {
  constructor(status: 404 | 409 | 422 | 502 | 503, code: string) {
    super(status, code);
  }
}

async function loadTaxProfile(c: PoolClient): Promise<TaxProfile> {
  const { rows } = await c.query<{
    method: TaxProfile["method"];
    state_bps: number;
    county_bps: number;
    city_bps: number;
    factor_bps: number | null;
  }>("SELECT method, state_bps, county_bps, city_bps, factor_bps FROM tenant_tax_profiles");
  const p = rows[0];
  if (!p) return { method: "none" }; // no profile yet → no tax (never a guess)
  return {
    method: p.method,
    stateBps: p.state_bps,
    countyBps: p.county_bps,
    cityBps: p.city_bps,
    factorBps: p.factor_bps ?? undefined,
  };
}

export interface IssueInvoiceInput {
  jobId: string;
  subtotalCents: number; // pre-tax billing amount
  retainageBps?: number;
  /** Required when the tenant's tax method is materials-cost. */
  materialsCostCents?: number;
  /**
   * The member discount, in basis points, from the customer's active plan.
   *
   * ⛔ THIS PARAMETER DID NOT EXIST. `membership_plans.discount_bps` is
   * collected on the plan form, printed as "15% off repairs" on every plan
   * card, stored on every agreement, and looked up by a working
   * `memberDiscountBps()` that had ZERO callers — because there was nothing
   * to hand it to. A member who was sold 15% off was billed full price by
   * the software, every single time.
   *
   * The concession posts to 3490 (contra-revenue), because a discount is
   * revenue given back, not an expense incurred.
   */
  discountBps?: number;
  memo?: string;
  issuedOn: string; // yyyy-mm-dd
  accounts: PostingAccounts;
}

export interface IssuedInvoice {
  id: string;
  invoiceNo: number;
  subtotalCents: number;
  taxCents: number;
  retainageCents: number;
  dueNowCents: number;
  journalEntryId: string;
}

/**
 * Issue an invoice: tax from the tenant's state profile, retainage split,
 * the balanced GL posting, and the invoice row — ONE transaction.
 */
export async function issueInvoice(
  scope: TenantScope,
  input: IssueInvoiceInput,
): Promise<IssuedInvoice> {
  if (!Number.isSafeInteger(input.subtotalCents) || input.subtotalCents <= 0) {
    throw new InvoiceError(422, "subtotal_must_be_positive");
  }
  return withTenant(scope, async (c) => {
    const profile = await loadTaxProfile(c);

    // ── the member discount, at last ──────────────────────────────────────
    // Computed here rather than imported from `agreements`, because
    // sales-invoicing importing agreements is the module cycle the ports
    // were arranged to avoid. The CALLER looks up the rate; this applies it.
    const discountBps = Math.max(0, Math.min(10_000, input.discountBps ?? 0));
    const discountCents =
      discountBps === 0 ? 0 : mulDivHalfUp(input.subtotalCents, discountBps, 10_000);
    // Tax is charged on what the customer ACTUALLY pays, not on the list
    // price they did not pay.
    const netSubtotal = input.subtotalCents - discountCents;

    const tax = computeTax(profile, {
      invoiceCents: netSubtotal,
      materialsCostCents: input.materialsCostCents,
    });
    const total = netSubtotal + tax.totalTaxCents;
    const retainage = splitRetainage(total, input.retainageBps ?? 0);

    const entry = postInvoiceIssued({
      occurredOn: input.issuedOn,
      accounts: input.accounts,
      // ⛔ REVENUE AT GROSS, discount as CONTRA-REVENUE. Netting the discount
      // into revenue would hide it: the shop could never answer "what did
      // memberships cost us in concessions this year?", which is the whole
      // question a membership programme has to justify itself against.
      revenueCents: input.subtotalCents,
      tax,
      retainage,
      dims: { jobId: input.jobId },
    });
    if (discountCents > 0) {
      // Receivables are debited for the NET (retainage was split on the net
      // total), while revenue is credited GROSS — so the entry is short on
      // the debit side by exactly the discount, and this line is what
      // balances it. 3490 is the seeded concessions account.
      entry.lines.push({ accountCode: CONCESSIONS, debitCents: discountCents });
    }
    const journalEntryId = await postJournalEntryTx(c, scope, entry);

    const counter = await c.query<{ value: string }>(
      "SELECT app.next_counter('invoice_no') AS value",
    );
    const invoiceNo = Number(counter.rows[0]!.value);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO invoices (tenant_id, job_id, invoice_no, subtotal_cents,
         tax_cents, retainage_bps, retainage_cents, due_now_cents,
         discount_bps, discount_cents,
         journal_entry_id, memo, issued_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        scope.tenantId, input.jobId, invoiceNo, input.subtotalCents,
        tax.totalTaxCents, input.retainageBps ?? 0, retainage.retainageCents,
        retainage.dueNowCents, discountBps, discountCents,
        journalEntryId, input.memo ?? "", input.issuedOn, scope.uid,
      ],
    );
    await c.query(
      `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid)
       VALUES ($1, 'invoiced', 'job', $2, $3)`,
      [scope.tenantId, input.jobId, scope.uid],
    );
    return {
      id: rows[0]!.id,
      invoiceNo,
      subtotalCents: input.subtotalCents,
      discountCents,
      taxCents: tax.totalTaxCents,
      retainageCents: retainage.retainageCents,
      dueNowCents: retainage.dueNowCents,
      journalEntryId,
    };
  });
}

// ------------------------------------------------- membership invoices
export interface AgreementInvoiceInput {
  agreementId: string;
  customerId: string;
  amountCents: number;
  issuedOn: string;
  memo: string;
  /**
   * Where the credit side lands — the one accounting fact that differs by
   * billing type (Cory 2026-08-03):
   *   2430 Deferred income          annual prepay (earned per visit later)
   *   3138 Service agreement revenue  monthly (that month IS earned)
   */
  creditAccountCode: "2430" | "3138";
}

/**
 * An invoice with NO job: memberships bill the customer relationship, not a
 * project. job_id stays NULL, agreement_id says what it is. No tax at issue
 * (service agreements are not retail sales of tangible goods; the tenant tax
 * profile applies to job invoices), no retainage (nothing is being held on a
 * subscription).
 *
 * Takes the caller's client — enrollment creates the agreement, its visits
 * AND this bill in ONE transaction, per the two-records-one-truth law.
 */
export async function issueAgreementInvoice(
  c: PoolClient,
  scope: TenantScope,
  input: AgreementInvoiceInput,
): Promise<{ id: string; invoiceNo: number; journalEntryId: string }> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new InvoiceError(422, "subtotal_must_be_positive");
  }
  const journalEntryId = await postJournalEntryTx(c, scope, {
    occurredOn: input.issuedOn,
    memo: input.memo,
    sourceType: "agreement-invoice",
    sourceId: input.agreementId,
    lines: [
      { accountCode: "1210", debitCents: input.amountCents },
      { accountCode: input.creditAccountCode, creditCents: input.amountCents },
    ],
  });

  const counter = await c.query<{ value: string }>(
    "SELECT app.next_counter('invoice_no') AS value",
  );
  const invoiceNo = Number(counter.rows[0]!.value);
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, job_id, agreement_id, invoice_no,
       subtotal_cents, tax_cents, retainage_bps, retainage_cents,
       due_now_cents, journal_entry_id, memo, issued_on, created_by)
     VALUES ($1,NULL,$2,$3,$4,0,0,0,$4,$5,$6,$7,$8) RETURNING id`,
    [
      scope.tenantId,
      input.agreementId,
      invoiceNo,
      input.amountCents,
      journalEntryId,
      input.memo,
      input.issuedOn,
      scope.uid,
    ],
  );
  await c.query(
    `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid)
     VALUES ($1, 'agreement_invoiced', 'agreement', $2, $3)`,
    [scope.tenantId, input.agreementId, scope.uid],
  );
  return { id: rows[0]!.id, invoiceNo, journalEntryId };
}

export interface RecordPaymentInput {
  invoiceId: string;
  amountCents: number;
  method?: "manual" | "check" | "ach" | "card" | "stripe";
  reference?: string;
  receivedOn: string;
  accounts: PostingAccounts;
}

/** Record a payment: GL posting + append-only payment row + invoice rollup, one tx. */
export async function recordPayment(
  scope: TenantScope,
  input: RecordPaymentInput,
): Promise<{
  paymentId: string;
  journalEntryId: string;
  invoiceStatus: string;
  /** True when `reference` had already been recorded — nothing was posted. */
  duplicate: boolean;
}> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new InvoiceError(422, "payment_must_be_positive");
  }
  return withTenant(scope, async (c) => {
    // FOR UPDATE: the overpayment guard below is a read-then-write on
    // paid_cents. Without the lock, two payments landing together — a
    // double-clicked "Record payment", or a Stripe retry racing a manual
    // entry — both read the same paid_cents, both pass the guard, and both
    // post. payBill() in purchasing-ap has always locked here; this side
    // didn't, and it is the side customers' money arrives on.
    const inv = await c.query<{
      id: string;
      job_id: string;
      net_subtotal_cents: string;
      tax_cents: string;
      paid_cents: string;
      due_now_cents: string;
      status: string;
    }>("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [input.invoiceId]);
    const invoice = inv.rows[0];
    if (!invoice) throw new InvoiceError(404, "invoice_not_found");
    if (invoice.status === "void") throw new InvoiceError(422, "invoice_void");

    // Idempotency, INSIDE the lock. The caller (the Stripe webhook) also
    // pre-checks, but that check ran in its own committed transaction — two
    // at-least-once deliveries both passed it before either INSERT landed.
    // Here the invoice row is already locked, so concurrent payers for this
    // invoice are serialized and the second one sees the first one's row.
    if (input.reference) {
      const seen = await c.query<{ id: string; journal_entry_id: string }>(
        "SELECT id, journal_entry_id FROM payments WHERE reference = $1",
        [input.reference],
      );
      const prior = seen.rows[0];
      if (prior) {
        return {
          paymentId: prior.id,
          journalEntryId: prior.journal_entry_id,
          invoiceStatus: invoice.status,
          duplicate: true,
        };
      }
    }

    // ⛔ NET, not subtotal. `subtotal_cents` is the GROSS list price; the
    // member discount lives in `discount_cents` and the tax was charged on
    // the difference. Adding tax to the gross invents an invoice total the
    // customer was never asked for — on a $10,000 job at 15% off, this
    // guard would have waved through $10,700 against a $9,200 invoice.
    const totalCents =
      Number(invoice.net_subtotal_cents) + Number(invoice.tax_cents);
    const paidAfter = Number(invoice.paid_cents) + input.amountCents;
    if (paidAfter > totalCents) {
      throw new InvoiceError(422, "payment_exceeds_invoice_total");
    }

    const entry = postPaymentReceived({
      occurredOn: input.receivedOn,
      accounts: input.accounts,
      amountCents: input.amountCents,
      dims: { jobId: invoice.job_id },
    });
    const journalEntryId = await postJournalEntryTx(c, scope, entry);

    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO payments (tenant_id, invoice_id, amount_cents, method,
         reference, journal_entry_id, received_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        scope.tenantId, input.invoiceId, input.amountCents,
        input.method ?? "manual", input.reference ?? null, journalEntryId,
        input.receivedOn, scope.uid,
      ],
    );
    const status =
      paidAfter >= Number(invoice.due_now_cents) ? "paid" : "partial";
    await c.query(
      "UPDATE invoices SET paid_cents = $2, status = $3 WHERE id = $1",
      [input.invoiceId, paidAfter, status],
    );
    await c.query(
      `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid)
       VALUES ($1, 'payment_received', 'job', $2, $3)`,
      [scope.tenantId, invoice.job_id, scope.uid],
    );
    return {
      paymentId: rows[0]!.id,
      journalEntryId,
      invoiceStatus: status,
      duplicate: false,
    };
  });
}

export interface InvoiceRow {
  id: string;
  invoiceNo: number;
  status: string;
  subtotalCents: number;
  taxCents: number;
  retainageCents: number;
  dueNowCents: number;
  paidCents: number;
  issuedOn: string;
}

export async function listInvoices(
  scope: TenantScope,
  jobId: string,
): Promise<InvoiceRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<InvoiceRow>(
      `SELECT id, invoice_no AS "invoiceNo", status,
              subtotal_cents AS "subtotalCents", tax_cents AS "taxCents",
              retainage_cents AS "retainageCents", due_now_cents AS "dueNowCents",
              paid_cents AS "paidCents", issued_on AS "issuedOn"
         FROM invoices WHERE job_id = $1 ORDER BY invoice_no DESC`,
      [jobId],
    );
    return rows.map((r) => ({
      ...r,
      subtotalCents: Number(r.subtotalCents),
      taxCents: Number(r.taxCents),
      retainageCents: Number(r.retainageCents),
      dueNowCents: Number(r.dueNowCents),
      paidCents: Number(r.paidCents),
    }));
  });
}

// -------------------------------------------------------------- sales tax
export const TAX_PAYABLE = "2350";

export interface TaxSummary {
  byMonth: { month: string; collectedCents: number; remitted: boolean }[];
  liabilityCents: number;
  explain: string;
}

/** What the tax engine accrued, by month, vs what's been remitted. */
export async function getSalesTaxSummary(scope: TenantScope): Promise<TaxSummary> {
  return withTenant(scope, async (c) => {
    const by = await c.query<{ month: string; collected: string }>(
      `SELECT to_char(issued_on, 'YYYY-MM') AS month,
              COALESCE(SUM(tax_cents), 0)::bigint AS collected
         FROM invoices WHERE status <> 'void' AND tax_cents > 0
        GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
    );
    const rem = await c.query<{ period_label: string }>(
      `SELECT period_label FROM tax_remittances`,
    );
    const remitted = new Set(rem.rows.map((r) => r.period_label));
    const bal = await c.query<{ bal: string }>(
      `SELECT COALESCE(SUM(l.credit_cents - l.debit_cents), 0)::bigint AS bal
         FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
        WHERE a.code = $1`,
      [TAX_PAYABLE],
    );
    const liabilityCents = Number(bal.rows[0]!.bal);
    const d = (cents: number) =>
      `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
    return {
      byMonth: by.rows.map((r) => ({
        month: r.month,
        collectedCents: Number(r.collected),
        remitted: remitted.has(r.month),
      })),
      liabilityCents,
      explain:
        liabilityCents > 0
          ? `You are holding ${d(liabilityCents)} of sales tax that belongs to the state. It sits in its own account — it was never counted as your money.`
          : "No sales tax owed right now.",
    };
  });
}

/** Remit one period's sales tax: DR 2350 / CR cash, once per period. */
export async function remitTax(
  scope: TenantScope,
  periodLabel: string,
  amountCents: number,
  remittedOn: string,
): Promise<{ journalEntryId: string }> {
  if (amountCents <= 0) throw new InvoiceError(422, "invalid_amount");
  return withTenant(scope, async (c) => {
    const journalEntryId = await postJournalEntryTx(c, scope, {
      occurredOn: remittedOn,
      memo: `Sales tax remittance, ${periodLabel}`,
      sourceType: "tax-remittance",
      lines: [
        { accountCode: TAX_PAYABLE, debitCents: amountCents },
        { accountCode: DEFAULT_POSTING_ACCOUNTS.cash, creditCents: amountCents },
      ],
    });
    try {
      await c.query(
        `INSERT INTO tax_remittances (tenant_id, period_label, amount_cents,
                                      remitted_on, journal_entry_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [scope.tenantId, periodLabel, amountCents, remittedOn, journalEntryId, scope.uid],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new InvoiceError(409, "period_already_remitted");
      }
      throw err;
    }
    return { journalEntryId };
  });
}
