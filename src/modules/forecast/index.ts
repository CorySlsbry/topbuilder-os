// forecast module — public port.
//
// The 13-week cash plan. Separate from `reporting`, which is read-only by
// charter and stays that way: this module needs its own reads, its own dated
// assumptions, and eventually somewhere for a shop to record them.
//
// Everything here is deterministic arithmetic over the books. Certainty is a
// CATEGORY derived from structure — which table a row is in and which columns
// are filled — never a score and never a model. There are no percentages in
// this module, on purpose: a percentage invites the reader to multiply by it.
import "server-only";

export {
  addWeeks,
  collectionLagDays,
  computeCashPlan,
  DEFAULT_LAG_DAYS,
  explainCashPlan,
  MIN_LAG_SAMPLES,
  mondayOf,
  overclaimedJobs,
  PLAN_WEEKS,
} from "./internal/cash-plan";
export type {
  CashItem,
  CashPlan,
  CashPlanInput,
  CashPlanWeek,
  Certainty,
  CollectionLag,
  JobClaim,
} from "./internal/cash-plan";

export { getCashPlan } from "./internal/store";
export type { CashPlanResult } from "./internal/store";
