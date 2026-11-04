// workforce module — public port.
//
// Workers with WC-class burden rates, crews, and time -> burdened labor on
// the GL: posting a worker-week debits 1430 with job dims at the TRUE cost
// of the hour (wages + FICA + unemployment + WC + benefits, OT split at the
// 40h line chronologically) and credits the payroll accruals (2400/2425)
// that the real payroll run clears later. Deterministic S3 math throughout.
import "server-only";

export { splitWeeklyOt, weekStartOf, WEEKLY_OT_THRESHOLD_X100 } from "./internal/ot";
export type { OtSplit, WeekEntry } from "./internal/ot";
export {
  ACCRUED_BURDEN,
  ACCRUED_WAGES,
  createCrew,
  createWorker,
  listCrews,
  listPendingLaborByJob,
  listPendingWeeks,
  listRoster,
  listWcClasses,
  listWorkers,
  logTime,
  postWorkerWeek,
  postWorkerWeekTx,
  setCrewMembers,
  upsertWcClass,
  WorkforceError,
} from "./internal/store";
export type {
  PendingLaborByJob,
  PendingWeek,
  TimeInput,
  WcClassRow,
  WorkerInput,
  WorkerRow,
} from "./internal/store";
export { runWorkforceAgent } from "./internal/agent-run";
export type { WorkforceRunReport } from "./internal/agent-run";
