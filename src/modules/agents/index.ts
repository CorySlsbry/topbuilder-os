// agents module — public port.
//
// Automation-first: deterministic automations do the work; an LLM (S11+) is
// a bounded helper that never computes a figure and never drives control
// flow. Everything mutating passes the action gate; every human decision
// (approve / revise / reject / undo) is a learning signal; money-movement
// kinds are ALWAYS_HITL; 5 failures dead-letter the run and flip the agent
// off. DISABLE_LLM runs the entire pipeline on deterministic templates.
import "server-only";

export {
  extractNumericTokens,
  figureUniverse,
  normalizeNumber,
  verifyFigures,
} from "./internal/figures";
export type { FigureCheck } from "./internal/figures";

export { actionsEnabled, kindAllowed, KINDS } from "./internal/registry";

export {
  AgentError,
  decide,
  listActions,
  listPolicies,
  propose,
  setMode,
  undoAction,
} from "./internal/gate";
export type { ActionRow, AgentMode, Decision, ProposeInput, ProposeResult } from "./internal/gate";
/**
 * The scope every agent entry point takes: tenant + the authorization facts
 * (role, departments, aal) exactly as `requireScope()` returns them. It is a
 * type, not a convention — a caller holding a bare TenantScope cannot reach
 * propose() or the action feeds, so the per-kind authz can't be skipped.
 */
export type { ActorScope as AgentActorScope } from "./internal/visibility";

export {
  approvePreference,
  demotePreference,
  distillPreference,
  listPreferences,
  retrieveCases,
} from "./internal/learning";
export type { CaseRow, PreferenceRow } from "./internal/learning";

export {
  checkBudget,
  finishRun,
  getDailyCost,
  listDeadLetters,
  MAX_ATTEMPTS,
  recordFailure,
  startRun,
} from "./internal/runs";
export type { DeadLetterRow } from "./internal/runs";

// Token -> money, in ONE place. A SAFETY RAIL for the daily cap, never an
// invoice: rates are approximate, over-estimate on purpose, and are overridable
// at runtime via AGENT_MODEL_RATES. Every path that calls a model costs itself
// with this and records the result in `assist_usage`, which is half of what
// `checkBudget` sums.
export { costMicroUsd, MODEL_RATES, overBudget, rateFor, ratesFromEnv } from "./internal/token-cost";
export type { ModelRate } from "./internal/token-cost";
export { recordAssistUsage } from "./internal/assist-usage";
export type { AssistUsageRow } from "./internal/assist-usage";
