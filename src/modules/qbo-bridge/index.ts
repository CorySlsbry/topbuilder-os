// qbo-bridge module — public port.
//
// WE are the book of record; QBO is a peripheral with three jobs:
// migration-in (switch a shop off QBO, verified to the penny), export
// forever (IIF + QBO-journal CSV — one-click reversibility), and the
// optional Accountant Sync (one-way push of our ledger into the CPA's
// QBO file). Tokens are encrypted at rest and never leave the server.
import "server-only";

export { buildIifJournal, buildQboJournalCsv } from "./internal/export";
export {
  buildAuthorizeUrl,
  completeConnection,
  disconnectQbo,
  getExportRows,
  getQboStatus,
  QboError,
  runAccountantSync,
  runQboImport,
  setSyncEnabled,
  verifyState,
} from "./internal/store";
export type { ImportReport, QboStatus, SyncReport } from "./internal/store";
