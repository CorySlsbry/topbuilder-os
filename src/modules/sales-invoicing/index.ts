// sales-invoicing module — public port.
//
// Invoices (tax from the tenant's state profile + retainage split) and the
// append-only payments ledger. Every money event posts to the GL in the SAME
// transaction as its operational row. Card payments (Stripe embedded
// checkout) activate when keys exist — see docs/NEEDS-CORY.md; recording a
// manual/check/ACH payment works day one.
export {
  InvoiceError,
  issueAgreementInvoice,
  issueInvoice,
  listInvoices,
  recordPayment,
} from "./internal/store";
export type {
  IssueInvoiceInput,
  IssuedInvoice,
  InvoiceRow,
  RecordPaymentInput,
} from "./internal/store";
export { getSalesTaxSummary, remitTax, TAX_PAYABLE } from "./internal/store";
export type { AgreementInvoiceInput, TaxSummary } from "./internal/store";

export {
  createInvoiceCheckout,
  handleCheckoutCompleted,
  paymentMac,
  stripeEnabled,
  StripeError,
  verifyStripeSignature,
} from "./internal/stripe";

// The CPA pair, half one: take a sale BACK cleanly. New documents + reversing
// postings — history is never edited, which is what makes it auditable.
export {
  createCreditMemo,
  listCreditMemos,
  listAllInvoices,
  refundCreditMemo,
  voidInvoice,
} from "./internal/credit";
export type { CreditMemoRow, InvoiceListRow } from "./internal/credit";
