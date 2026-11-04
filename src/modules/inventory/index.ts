// inventory module — public port.
//
// Book = shelf: every stock move that changes value posts to the GL in the
// same transaction (receipt DR 1310/CR AP via a real vendor bill; issue to
// job DR 1430-with-dims/CR 1310 at the moving average; count adjustment
// vs 3830). The moves table is the append-only stock ledger; the Restocker
// proposes reorder POs when items hit their reorder point.
import "server-only";

export { extendedCents, receiptAverage } from "./internal/avgcost";
export {
  adjustCount,
  createItem,
  createStockPoTx,
  INVENTORY_ACCOUNT,
  InventoryError,
  issueToJob,
  listItems,
  listLowStock,
  receiveStock,
  SHRINKAGE_ACCOUNT,
} from "./internal/store";
export type {
  AdjustInput,
  IssueInput,
  ItemInput,
  ItemRow,
  ReceiveInput,
} from "./internal/store";
export { runInventoryAgent } from "./internal/agent-run";
export type { InventoryRunReport } from "./internal/agent-run";
