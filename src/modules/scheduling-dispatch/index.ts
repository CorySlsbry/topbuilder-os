// scheduling-dispatch module — public port.
//
// The dispatch board: appointments × workers × days, click-to-assign (no
// drag-drop ceremony — keyboard-friendly, WCAG-clean). The Dispatcher
// proposes least-loaded assignments; assignment carries no money, so it is
// the first NON-HITL, UNDOABLE agent kind (auto mode executes, undo
// unassigns).
import "server-only";

export { pickLeastLoaded } from "./internal/balance";
export type { Candidate } from "./internal/balance";
export {
  assignAppointment,
  assignAppointmentTx,
  DispatchError,
  getBoard,
  setAppointmentStatus,
  unassignedWithLoads,
} from "./internal/store";
export type { Board, BoardAppointment, UnassignedAppt } from "./internal/store";
export { runDispatchAgent } from "./internal/agent-run";
export type { DispatchRunReport } from "./internal/agent-run";
