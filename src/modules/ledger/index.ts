// ledger module — public port.
//
// The double-entry general ledger: THE book of record. Every number is
// deterministic, TDD'd code — never AI-invented. Other modules post THROUGH
// this port; nothing else writes ledger tables. Corrections are reversing
// entries; posted rows are immutable (enforced at grant + trigger level).
import "server-only";

export {
  LedgerError,
  validateEntry,
  type EntryInput,
  type EntryLineInput,
} from "./internal/validate";
export {
  closePeriod,
  getTrialBalance,
  listPeriods,
  getEntryLinesTx,
  postJournalEntry,
  postJournalEntryTx,
  seedNahbChart,
  type TrialBalanceRow,
} from "./internal/store";
