// billing module — public port.
//
// The SaaS subscription (distinct from customer invoices, which live in
// sales-invoicing). Two flat plans, no per-head fee. Checkout is EMBEDDED
// so the customer never leaves our branding; upgrade, downgrade, and cancel
// all happen inside the app with no retention maze; the webhook resolves
// the tenant from our own row, never from the payload. Fails closed
// without keys.
import "server-only";

export {
  can,
  CAPABILITY_FLOOR,
  checkSeat,
  explainSubscription,
  isUpgrade,
  missingCapabilities,
  PLAN_LIST,
  PLANS,
  planFor,
} from "./internal/plans";
export type { Capability, Plan, PlanKey, SeatCheck } from "./internal/plans";

export { assertCapability, tenantCapabilities } from "./internal/entitlements";

export { BillingError, billingEnabled, priceExists, publishableKey } from "./internal/stripe-api";

export {
  applyBillingEvent,
  assertSeatAvailable,
  billingPortalUrl,
  cancelSubscription,
  cancelSubscriptionNow,
  stripeRefFor,
  changePlan,
  getSubscription,
  resumeSubscription,
  startCheckout,
} from "./internal/store";
export type { SubscriptionState } from "./internal/store";
