// reporting module — public port.
//
// CQRS-lite: reporting is a READ-ONLY projection of the general ledger.
// Every figure is deterministic arithmetic over posted journal lines;
// every screen gets chart-ready data plus a plain-language explain().
// This module never writes.
import "server-only";

export {
  buildBalanceSheet,
  buildCashFlow,
  buildProfitAndLoss,
  buildTrialBalance,
} from "./internal/statements";
export type {
  AccountBalance,
  BalanceSheet,
  CashFlow,
  ProfitAndLoss,
  StatementLine,
  TrialBalance,
} from "./internal/statements";

export {
  getArAging,
  getCashForecast,
  getOwnerKpis,
  getGlDetail,
  getScoreboard,
  getStatements,
} from "./internal/store";
export type {
  ArAging,
  CashForecast,
  ForecastWeek,
  OwnerKpis,
  GlDetailRow,
  Scoreboard,
  ScoreboardJob,
  StatementsResult,
} from "./internal/store";

export { buildZip, csvDollars, toCsv } from "./internal/pack";
export type { ZipEntry } from "./internal/pack";

export { getLirCohorts, isPlatformOperator, LIR_TARGET_BPS } from "./internal/lir";
export type { LirCohort } from "./internal/lir";

// The tenant's cash accounts, as SQL. Shared with  so the cash plan
// and the statements can never disagree about what cash means.
export { CASH_CODES_SQL } from "./internal/store";

// The decision list — the top of every dashboard, and the only part of a
// dashboard anybody reliably reads. Pure: it renders sentences from figures
// the deterministic layer already computed, and does no finance of its own.
export { buildDecisions, nothingToDecide } from "./internal/decisions";
export type { Decision, DecisionFacts } from "./internal/decisions";
