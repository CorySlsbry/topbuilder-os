// prospecting — the sales side of the book the shop already owns.
//
// Territory map pins, an opportunity pipeline with append-only stage
// history, and the geocoding that turns the book's addresses into
// coordinates. Own-book by design: every pin and every fact on it comes
// from tables this product already maintains — nothing licensed, nothing
// inferred, nothing the owner can't click through and verify.

export { geocodePending } from "./internal/geocode";
export type { GeocodeReport } from "./internal/geocode";
export {
  advanceStage,
  createOpportunity,
  listOpportunities,
  ProspectingError,
  STAGES,
} from "./internal/store";
export type { OpportunityRow, Stage } from "./internal/store";
export { listTargets, setTargetDisposition } from "./internal/targets";
export type { TargetWithState } from "./internal/targets";
export { sendOutreachTx } from "./internal/store";
export { outreachDraft } from "./internal/outreach";
export type { OutreachDraft } from "./internal/outreach";
export { runSalesAgent } from "./internal/agent-run";
export type { SalesRunReport } from "./internal/agent-run";
