// purchasing-ap module — public port.
//
// Vendors, bills (AP), vendor payments, and 1099 tracking. A bill posts
// DR job-cost-with-dims or expense / CR 2110 AP atomically with its rows;
// paying posts DR 2110 / CR cash; bill_payments are append-only at both
// layers. The received-PO -> bill-draft flow feeds the Documents agent.
import "server-only";

export {
  ApError,
  createBill,
  createBillTx,
  createVendor,
  getBill,
  ensureVendorTx,
  get1099Summary,
  listBills,
  listReceivedPosWithoutBills,
  listVendors,
  payBill,
} from "./internal/store";
export { runDocumentsAgent } from "./internal/agent-run";
export type { DocumentsRunReport } from "./internal/agent-run";
export type {
  BillDetail,
  BillLineRow,
  BillPaymentRow,
  BillInput,
  BillLineInput,
  BillRow,
  ReceivedPo,
  Ten99Row,
  VendorInput,
  VendorRow,
} from "./internal/store";

// Sending money to vendors through a licensed partner. The provider itself is
// not wired yet — the partner account needs the business's own KYB and a
// signed agreement, so it is Cory's to open. Every send path fails CLOSED
// (503 bill_pay_not_connected) rather than pretending to have paid someone.
export { activeProvider, billPayStatus } from "./internal/bill-pay";
export type { BillPayProvider, BillPayStatus } from "./internal/bill-pay";
