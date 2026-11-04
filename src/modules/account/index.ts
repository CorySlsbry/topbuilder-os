// account module — public port.
//
// Data ownership, self-service: download everything (one ZIP, one CSV per
// table, read under the tenant's own RLS scope so a cross-tenant export is
// impossible by construction) and delete everything (typed confirmation,
// subscription canceled, then a definer purge bound to the session's own
// tenant — the only path that may touch the append-only money tables).
import "server-only";

export {
  AccountError,
  deleteEverything,
  deletionPreview,
  exportEverything,
} from "./internal/store";
export type { DeletionPreview } from "./internal/store";

// The streamed export.  above buffers the whole archive and
// is kept only for the tests that pin its output shape — the ROUTE uses this.
export { streamExport } from "./internal/export-stream";
