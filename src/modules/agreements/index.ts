// agreements module — public port.
//
// Service agreements (memberships): plans, enrollment, visits, renewal, and
// the revenue-recognition choreography. Annual prepay parks in 2430 Deferred
// income and is EARNED PER COMPLETED VISIT via a stored release schedule
// whose sum is exact (rec.test.ts holds the invariant); monthly fees earn in
// their month. Invoice rows are written by sales-invoicing's port — this
// module never touches another module's tables.
//
// Member benefits compose at the ROUTE layer: memberDiscountBps() feeds
// issueInvoice's discount input, so sales-invoicing never imports agreements
// and the dependency graph stays a DAG.
import "server-only";

export {
  AgreementError,
  bookVisit,
  cancelAgreement,
  completeVisit,
  createPlan,
  enroll,
  listAgreements,
  listPlans,
  listVisits,
  memberDiscountBps,
  rolloverDue,
  setPlanActive,
} from "./internal/store";
export type { AgreementRow, PlanInput, PlanRow, VisitRow } from "./internal/store";
export {
  deferredBalanceCents,
  memberDiscountCents,
  visitDueDates,
  visitReleaseSchedule,
} from "./internal/rec";

// Card-on-file: Stripe references only; the customer types the card into
// Stripe's element via their portal. Off-session charges power monthly
// autopay.
export {
  CardError,
  chargeSavedCard,
  confirmCardSetup,
  createCardSetup,
  listSavedCards,
} from "./internal/stripe";
export type { SavedCard } from "./internal/stripe";

// The hand that was missing: completing the tune-up JOB is what recognises
// the visit's slice of deferred revenue. See completeVisitForJob.
export { completeVisitForJob, reopenVisit } from "./internal/store";
