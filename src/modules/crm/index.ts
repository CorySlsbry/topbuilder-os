// crm module — public port.
//
// Customers as first-class: the CRM list with open AR, the customer
// portal (revocable token door — customers see their jobs/invoices and
// approve estimates from the couch), review requests for happy customers,
// and friendly payment reminders. Every outward message is ALWAYS_HITL:
// nothing reaches a customer without the owner's yes.
import "server-only";

export {
  createPortalToken,
  createReviewRequestTx,
  CrmError,
  dunningMessage,
  getPortalCustomerScope,
  getPortalData,
  getPortalScopeForInvoice,
  listCustomers,
  overdueInvoices,
  portalApproveChangeOrder,
  portalApproveEstimate,
  recordDunningTx,
  reviewCandidates,
  revokePortalTokens,
  updateCustomerContact,
} from "./internal/store";
export type {
  CustomerRow,
  OverdueInvoice,
  PortalData,
  ReviewCandidate,
} from "./internal/store";
export { runCrmAgent } from "./internal/agent-run";
export type { CrmRunReport } from "./internal/agent-run";
