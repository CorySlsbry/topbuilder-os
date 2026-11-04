// books-qa module — public port.
//
// A READ-ONLY question about the shop's own records, answered from tool
// results only. Deliberately NOT an agent kind: KindSpec models
// propose->approve->execute of a MUTATION, and a question has nothing to
// execute and nothing to undo.
//
// It reuses the agent budget and run tables so a tenant's model spend stays
// ONE number rather than two separately-capped pockets.
import "server-only";

export {
  askBooks,
  booksQaAvailable,
  BooksQaError,
  deterministicAnswer,
  MAX_OUTPUT_TOKENS,
  MAX_RESULT_CHARS,
  MAX_TOOL_CALLS,
  MAX_TURNS,
} from "./internal/ask";
export type { BooksAnswer, Citation } from "./internal/ask";
export { TOOLS, toolByName, toolsFor } from "./internal/tools";
export type { BooksTool } from "./internal/tools";
