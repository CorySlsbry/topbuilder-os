// Posting rules — the deterministic map from business events to balanced
// journal entries. These builders RETURN EntryInput for the ledger port;
// they never touch the DB. Account codes come from the tenant's COA mapping
// (passed in) — nothing hardcoded. Pure, integer cents, TDD'd.
import type { EntryInput } from "@/modules/ledger";
import { JobCostError } from "./wip";
import type { TaxResult } from "./tax";
import type { RetainageSplit } from "./retainage";

/** The tenant's account mapping for posting (resolved from their COA). */
export interface PostingAccounts {
  cash: string; // 10xx
  ar: string; // accounts receivable
  retainageReceivable: string; // held-by-customer retainage
  revenue: string; // sales/revenue for the job's class
  taxPayable: string; // sales-tax liability (never revenue)
  customerDeposits: string; // unearned customer deposits (liability)
  dealerFeeCost: string; // financing/dealer-fee cost account
  jobCost: string; // direct job cost (5xxx/38xx per cost code)
  ap: string; // accounts payable
}

interface Dims {
  jobId?: string;
  costCode?: string;
  class?: string;
  customerId?: string;
  vendorId?: string;
}

function positive(n: number, code: string): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new JobCostError(code);
  return n;
}

/**
 * Invoice issued (with optional retainage held and sales tax):
 *   DR AR (due now) + DR retainage receivable (held)
 *   CR revenue (the pre-tax amount) + CR tax payable (never revenue)
 */
export function postInvoiceIssued(args: {
  occurredOn: string;
  accounts: PostingAccounts;
  revenueCents: number; // pre-tax contract billing
  tax: TaxResult;
  retainage: RetainageSplit; // computed over revenue+tax total billed
  sourceId?: string;
  dims?: Dims;
}): EntryInput {
  const revenue = positive(args.revenueCents, "invoice_revenue_must_be_positive");
  const taxTotal = args.tax.totalTaxCents;
  const total = revenue + taxTotal;
  if (args.retainage.dueNowCents + args.retainage.retainageCents !== total) {
    throw new JobCostError("retainage_split_must_cover_invoice_total");
  }
  const d = args.dims ?? {};
  const lines: EntryInput["lines"] = [
    { accountCode: args.accounts.ar, debitCents: args.retainage.dueNowCents, ...d },
  ];
  if (args.retainage.retainageCents > 0) {
    lines.push({
      accountCode: args.accounts.retainageReceivable,
      debitCents: args.retainage.retainageCents,
      ...d,
    });
  }
  lines.push({ accountCode: args.accounts.revenue, creditCents: revenue, ...d });
  if (taxTotal > 0) {
    lines.push({ accountCode: args.accounts.taxPayable, creditCents: taxTotal, ...d });
  }
  return {
    occurredOn: args.occurredOn,
    memo: "Invoice issued",
    sourceType: "invoice",
    sourceId: args.sourceId,
    lines,
  };
}

/** Customer payment received: DR cash / CR AR. */
export function postPaymentReceived(args: {
  occurredOn: string;
  accounts: PostingAccounts;
  amountCents: number;
  sourceId?: string;
  dims?: Dims;
}): EntryInput {
  const amount = positive(args.amountCents, "payment_must_be_positive");
  const d = args.dims ?? {};
  return {
    occurredOn: args.occurredOn,
    memo: "Payment received",
    sourceType: "payment",
    sourceId: args.sourceId,
    lines: [
      { accountCode: args.accounts.cash, debitCents: amount, ...d },
      { accountCode: args.accounts.ar, creditCents: amount, ...d },
    ],
  };
}

/** Field cost captured: DR job cost (with job+cost-code dims) / CR cash or AP. */
export function postCostCaptured(args: {
  occurredOn: string;
  accounts: PostingAccounts;
  amountCents: number;
  paidFrom: "cash" | "ap";
  sourceId?: string;
  dims: Dims & { jobId: string; costCode: string }; // job costs REQUIRE dims
}): EntryInput {
  const amount = positive(args.amountCents, "cost_must_be_positive");
  return {
    occurredOn: args.occurredOn,
    memo: "Job cost captured",
    sourceType: "cost",
    sourceId: args.sourceId,
    lines: [
      { accountCode: args.accounts.jobCost, debitCents: amount, ...args.dims },
      {
        accountCode: args.paidFrom === "cash" ? args.accounts.cash : args.accounts.ap,
        creditCents: amount,
        ...args.dims,
      },
    ],
  };
}

/**
 * Insurance-restoration ACV check received: DR cash / CR customer deposits.
 * NOT revenue — revenue is earned at completion. (The classic mis-posting
 * that buries an AR balance under negative deposits.)
 */
export function postInsuranceAcvReceived(args: {
  occurredOn: string;
  accounts: PostingAccounts;
  amountCents: number;
  sourceId?: string;
  dims?: Dims;
}): EntryInput {
  const amount = positive(args.amountCents, "acv_must_be_positive");
  const d = args.dims ?? {};
  return {
    occurredOn: args.occurredOn,
    memo: "Insurance ACV received — held as customer deposit (not yet earned)",
    sourceType: "insurance-acv",
    sourceId: args.sourceId,
    lines: [
      { accountCode: args.accounts.cash, debitCents: amount, ...d },
      { accountCode: args.accounts.customerDeposits, creditCents: amount, ...d },
    ],
  };
}

/**
 * Job completion on an insurance job: the held deposit is now EARNED —
 * DR customer deposits / CR revenue.
 */
export function postDepositEarned(args: {
  occurredOn: string;
  accounts: PostingAccounts;
  amountCents: number;
  sourceId?: string;
  dims?: Dims;
}): EntryInput {
  const amount = positive(args.amountCents, "earned_deposit_must_be_positive");
  const d = args.dims ?? {};
  return {
    occurredOn: args.occurredOn,
    memo: "Customer deposit earned at completion",
    sourceType: "deposit-earned",
    sourceId: args.sourceId,
    lines: [
      { accountCode: args.accounts.customerDeposits, debitCents: amount, ...d },
      { accountCode: args.accounts.revenue, creditCents: amount, ...d },
    ],
  };
}

/**
 * Financed-sale funding with a dealer fee (e.g. financed solar): revenue is
 * the GROSS contract; the dealer fee is a COST, not a revenue reduction.
 *   DR cash (net wired) + DR dealer-fee cost = CR revenue (gross)
 */
export function postFinancedFunding(args: {
  occurredOn: string;
  accounts: PostingAccounts;
  grossContractCents: number;
  dealerFeeCents: number;
  sourceId?: string;
  dims?: Dims;
}): EntryInput {
  const gross = positive(args.grossContractCents, "gross_must_be_positive");
  const fee = args.dealerFeeCents;
  if (!Number.isSafeInteger(fee) || fee < 0 || fee >= gross) {
    throw new JobCostError("dealer_fee_out_of_range");
  }
  const d = args.dims ?? {};
  const lines: EntryInput["lines"] = [
    { accountCode: args.accounts.cash, debitCents: gross - fee, ...d },
  ];
  if (fee > 0) {
    lines.push({ accountCode: args.accounts.dealerFeeCost, debitCents: fee, ...d });
  }
  lines.push({ accountCode: args.accounts.revenue, creditCents: gross, ...d });
  return {
    occurredOn: args.occurredOn,
    memo: "Financed funding — gross revenue, dealer fee as cost",
    sourceType: "financed-funding",
    sourceId: args.sourceId,
    lines,
  };
}
