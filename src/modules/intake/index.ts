// intake module — public port.
//
// Call intake + booking: every inbound request (voice webhook, website
// form, manual) lands in one idempotent queue; open slots are computed
// from REAL capacity (workers × windows − booked); the Receptionist books
// the earliest matching slot — undoably, and never a time the crew can't
// make. Voice transport (Retell) plugs into the same queue when keys land.
import "server-only";

export {
  computeOpenSlots,
  localDate,
  localWindow,
  pickSlot,
  zonedTimeToUtc,
} from "./internal/slots";
export type { OpenSlot, SlotInput } from "./internal/slots";
export {
  bookIntakeTx,
  createIntake,
  IntakeError,
  listIntake,
  openSlots,
  publicCreateIntake,
  publicTenantIdBySlug,
  setIntakeStatus,
  unbookIntakeTx,
} from "./internal/store";
export type { IntakeInput, IntakeRow } from "./internal/store";
// Online self-booking — the public door onto the same scheduling engine the
// Receptionist uses, plus the owner switch that decides whether it exists.
export {
  getBookingSettings,
  publicBookingProfile,
  publicOpenSlots,
  publicSelfBook,
  PUBLIC_BOOKER_UID,
  updateBookingSettings,
} from "./internal/public-booking";
export type {
  BookingProfile,
  BookingSettings,
  SelfBookInput,
  SelfBookResult,
} from "./internal/public-booking";

export { runIntakeAgent } from "./internal/agent-run";
export type { IntakeRunReport } from "./internal/agent-run";
