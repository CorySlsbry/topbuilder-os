// financial-agent module — public port.
//
// The Bookkeeper: the wedge agent. Scans the bank For-Review queue and
// turns each unknown into a plain-language question card proposed through
// the action gate (ALWAYS_HITL — a card never executes without a human).
// Fully deterministic: figures come verbatim from the transaction, memo
// text is inert data, and every human answer teaches the next proposal.
import "server-only";

export { buildQuestionCard, FALLBACK_EXPENSE_ACCOUNT } from "./internal/cards";
export type { CardContext, QuestionCard, QueueTxn } from "./internal/cards";
export { runFinancialAgent } from "./internal/run";
export type { FinancialRunReport } from "./internal/run";
