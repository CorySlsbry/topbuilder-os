// job-costing module — public port.
//
// The deterministic money math: every function is pure, integer-cents, and
// TDD'd — never AI-invented. Each module also ships a chart-ready result
// shape and a plain-language `explain*()` (4th-grade wording, deterministic
// template) so every screen can show the graph AND what it means.
export { computeWip, explainWip, JobCostError } from "./internal/money/wip";
export type { WipInput, WipResult } from "./internal/money/wip";

export { computeBurdenedLabor, explainBurden } from "./internal/money/burden";
export type { BurdenRate, BurdenedLabor } from "./internal/money/burden";

export { computeCommitted, explainCommitted } from "./internal/money/committed";
export type { CommittedInput, CommittedResult } from "./internal/money/committed";

export {
  splitRetainage,
  releaseRetainage,
  explainRetainage,
} from "./internal/money/retainage";
export type { RetainageSplit, RetainageRelease } from "./internal/money/retainage";

export { computeTax, explainTax } from "./internal/money/tax";
export type { TaxMethod, TaxProfile, TaxInput, TaxResult } from "./internal/money/tax";

export {
  buildPersonalReclass,
  personalDestination,
  suspectPersonal,
  explainPersonal,
} from "./internal/money/personal";
export type {
  EntityType,
  PersonalReclassInput,
  PersonalSuspicion,
} from "./internal/money/personal";

export {
  postCostCaptured,
  postDepositEarned,
  postFinancedFunding,
  postInsuranceAcvReceived,
  postInvoiceIssued,
  postPaymentReceived,
} from "./internal/money/postings";
export type { PostingAccounts } from "./internal/money/postings";

export {
  computeCodeBudget,
  rollupJobBudget,
  explainJobBudget,
} from "./internal/money/budget";

export {
  computeJobProfit,
  crewProfitView,
  explainCrewProfit,
  explainJobProfit,
} from "./internal/money/job-profit";
export type {
  CrewProfitView,
  JobProfitInput,
  JobProfitResult,
} from "./internal/money/job-profit";

export { explainWipPortfolio } from "./internal/money/wip";

// Who may see what a job made — the per-tenant decision, off by default.
export { getJobVisibility, setJobVisibility } from "./internal/visibility";
export type { JobVisibility } from "./internal/visibility";

export { explainFinancing, monthlyPaymentCents } from "./internal/money/financing";
export type { FinancingTerms } from "./internal/money/financing";

// DB-reading costing surface (WIP screens, committed costs, snapshots).
export {
  addPurchaseOrder,
  CostingError,
  getJobCosting,
  getWipReport,
  listPurchaseOrders,
  setEtc,
  setPurchaseOrderStatus,
  takeWipSnapshot,
} from "./internal/costing";
export type { JobCosting, PurchaseOrderRow } from "./internal/costing";
export type {
  CodeBudgetInput,
  CodeBudgetResult,
  JobBudgetRollup,
} from "./internal/money/budget";

// Cost codes — the dimension that makes job costing, WIP, a schedule of
// values and an underwriter's contracts-in-progress report mean anything.
export {
  CostCodeError,
  defaultCostCode,
  listCostCodes,
  seedCostCodePreset,
  upsertCostCode,
} from "./internal/cost-codes";
export type { CostCodeInput, CostCodeRow } from "./internal/cost-codes";
export { COST_CODE_PRESETS, findPreset, presetRows } from "./internal/cost-code-library";
export type { CostCodePreset, CostCodeSeed, CostKind } from "./internal/cost-code-library";

// Bonding & surety — the four schedules an underwriter asks for, generated
// from the shop's own ledger, plus the percentage-of-completion adjusting
// entry that makes the balance sheet agree with them.
export {
  BondingError,
  deleteCreditFacility,
  getBacklog,
  getCipSchedule,
  getCompletedContracts,
  getRatioPanel,
  listCreditFacilities,
  postWipAdjustment,
  setSuretyClass,
  upsertCreditFacility,
} from "./internal/bonding";
export type {
  Backlog,
  BacklogRow,
  CipSchedule,
  CipScheduleRow,
  CompletedContractRow,
  CompletedContracts,
  CreditFacility,
  RatioPanel,
  WipAdjustmentResult,
} from "./internal/bonding";
export {
  computeCipRow,
  computeFadeRow,
  computeSuretyRatios,
  explainCip,
  explainFade,
  explainRatios,
  summarizeFade,
} from "./internal/money/surety";
export type {
  CipInput,
  CipRow,
  FadeInput,
  FadeRow,
  FadeSummary,
  SuretyRatioInput,
  SuretyRatios,
} from "./internal/money/surety";
