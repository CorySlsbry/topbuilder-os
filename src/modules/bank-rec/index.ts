// bank-rec module — public port.
//
// The bank plane: file-first statement import (CSV/OFX; Plaid slots in when
// keys exist), fingerprint dedupe, auto-match against money already on the
// books, the For-Review queue with rule + personal suggestions, learning
// rules (suggest-only — the human gate stays), and reconcile-to-zero period
// locks. "Reconciled clean on our books" — the LIR's final loop event.
export {
  BankError,
  createBankAccount,
  DEFAULT_GL_BY_KIND,
  importStatement,
  listBankAccounts,
  listBankTxns,
  getBookBalance,
  listPostedTxns,
  listResolutions,
  reconcile,
  resolveBankTxn,
  resolveBankTxnTx,
} from "./internal/store";
export type {
  BankAccount,
  BankTxnRow,
  ImportSummary,
  PostedTxnRow,
  ReconcileResult,
  ResolutionRow,
  ResolveAction,
  SplitLine,
} from "./internal/store";
export { listCategories, listCostCodes } from "./internal/categories";
export type { Category, CostCodeOption } from "./internal/categories";
export { recategorizeBankTxn } from "./internal/recategorize";
export type { CorrectionAction, RecategorizeResult } from "./internal/recategorize";
export {
  detectFormat,
  fingerprint,
  normalizeDescription,
  parseCsvStatement,
  parseOfx,
  ruleMatcherFrom,
} from "./internal/parse";
export type { ParseResult, StatementTxn } from "./internal/parse";

// Live bank feeds — provider-agnostic. The ledger never learns the
// provider's name; adding Plaid beside Teller is a new adapter file.
export {
  connectFeed,
  disconnectFeed,
  FeedError,
  listConnections,
  listProviders,
  syncFeed,
} from "./internal/feeds/sync";
export type { ConnectionRow, ConnectResult, SyncResult } from "./internal/feeds/sync";
export type {
  FeedAccount,
  FeedProvider,
  FeedTransaction,
  ProviderKey,
} from "./internal/feeds/types";
