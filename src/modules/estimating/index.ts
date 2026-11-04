// estimating module — public port.
//
// The pricebook + good-better-best estimates ("options selling" — the
// revenue-engine feature ST fans credit with real money). Approving an
// option sets the job's contract, which drives WIP and billing.
export {
  addPricebookItem,
  approveEstimate,
  createEstimate,
  EstimateError,
  lineTotalCents,
  listPricebook,
} from "./internal/store";
export type { EstimateOptionInput, PricebookItem } from "./internal/store";

// Contract movement math — pure, no I/O, the half-up rules that make a deduct
// and its reversal cancel exactly.
export {
  changeOrderLineTotal,
  changeOrderTotalCents,
  checkChangeOrder,
  explainContract,
  summarizeContract,
} from "./internal/contract";
export type { ChangeOrderLineInput, ContractMovement, ContractSummary } from "./internal/contract";

// Change orders — the document that legitimately moves an awarded contract.
// `approveEstimate` refuses a second award precisely so this exists instead.
export {
  approveChangeOrder,
  approveChangeOrderTx,
  createChangeOrder,
  declineChangeOrder,
  getJobContract,
  sendChangeOrder,
  voidChangeOrder,
} from "./internal/change-orders";
export type {
  ChangeOrderRow,
  CreateChangeOrderInput,
  JobContract,
} from "./internal/change-orders";
export { getPricebookPhoto, setPricebookPhoto } from "./internal/store";
