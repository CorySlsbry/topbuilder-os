// Financial statements — pure, deterministic builders.
//
// Input is account balances read from OUR general ledger (debit-positive
// cents). Every figure is arithmetic over those balances; explain*() quotes
// figures verbatim in 4th-grade language. Nothing here is AI-invented and
// nothing here writes — reporting is a read-only projection of the ledger.

export type AccountType =
  | "asset"
  | "liability"
  | "equity"
  | "revenue"
  | "cogs"
  | "expense";

export interface AccountBalance {
  code: string;
  name: string;
  type: AccountType;
  /** Debits minus credits, integer cents (debit-positive). */
  balanceCents: number;
}

export interface StatementLine {
  code: string;
  name: string;
  amountCents: number;
}

function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

function lines(
  balances: AccountBalance[],
  type: AccountType,
  creditPositive: boolean,
): StatementLine[] {
  return balances
    .filter((b) => b.type === type && b.balanceCents !== 0)
    .map((b) => ({
      code: b.code,
      name: b.name,
      amountCents: creditPositive ? -b.balanceCents : b.balanceCents,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

const sum = (rows: StatementLine[]) =>
  rows.reduce((t, r) => t + r.amountCents, 0);

// ---------------------------------------------------------------- P&L
export interface ProfitAndLoss {
  revenue: StatementLine[];
  revenueCents: number;
  costOfSales: StatementLine[];
  costOfSalesCents: number;
  grossProfitCents: number;
  expenses: StatementLine[];
  expensesCents: number;
  netIncomeCents: number;
  explain: string;
}

export function buildProfitAndLoss(balances: AccountBalance[]): ProfitAndLoss {
  const revenue = lines(balances, "revenue", true);
  const costOfSales = lines(balances, "cogs", false);
  const expenses = lines(balances, "expense", false);
  const revenueCents = sum(revenue);
  const costOfSalesCents = sum(costOfSales);
  const expensesCents = sum(expenses);
  const grossProfitCents = revenueCents - costOfSalesCents;
  const netIncomeCents = grossProfitCents - expensesCents;
  const explain =
    netIncomeCents >= 0
      ? `You sold ${dollars(revenueCents)} of work. After the cost of doing the jobs and running the business, you kept ${dollars(netIncomeCents)}. That is your profit for this period.`
      : `You sold ${dollars(revenueCents)} of work, but costs were bigger than sales. You lost ${dollars(-netIncomeCents)} this period.`;
  return {
    revenue,
    revenueCents,
    costOfSales,
    costOfSalesCents,
    grossProfitCents,
    expenses,
    expensesCents,
    netIncomeCents,
    explain,
  };
}

// ------------------------------------------------------- Balance sheet
export interface BalanceSheet {
  assets: StatementLine[];
  assetsCents: number;
  liabilities: StatementLine[];
  liabilitiesCents: number;
  equity: StatementLine[];
  /** Equity account balances + current-period earnings. */
  equityCents: number;
  currentEarningsCents: number;
  /** liabilitiesCents + equityCents — must equal assetsCents. */
  liabilitiesAndEquityCents: number;
  ties: boolean;
  explain: string;
}

export function buildBalanceSheet(balances: AccountBalance[]): BalanceSheet {
  const assets = lines(balances, "asset", false);
  const liabilities = lines(balances, "liability", true);
  const equity = lines(balances, "equity", true);
  // Income accounts have not been closed to equity, so current earnings
  // (revenue − cogs − expenses over all time in the ledger) plug equity.
  const currentEarningsCents =
    sum(lines(balances, "revenue", true)) -
    sum(lines(balances, "cogs", false)) -
    sum(lines(balances, "expense", false));
  const assetsCents = sum(assets);
  const liabilitiesCents = sum(liabilities);
  const equityCents = sum(equity) + currentEarningsCents;
  const liabilitiesAndEquityCents = liabilitiesCents + equityCents;
  const ties = assetsCents === liabilitiesAndEquityCents;
  const explain = `Your company owns ${dollars(assetsCents)} of stuff (cash, money owed to you, work in progress). It owes ${dollars(liabilitiesCents)}. What is left over — ${dollars(equityCents)} — is yours.`;
  return {
    assets,
    assetsCents,
    liabilities,
    liabilitiesCents,
    equity,
    equityCents,
    currentEarningsCents,
    liabilitiesAndEquityCents,
    ties,
    explain,
  };
}

// ----------------------------------------------------------- Cash flow
/** One journal entry's effect on cash, bucketed by its counter-accounts. */
export interface CashMovement {
  /** Net change to cash accounts in the entry, signed cents. */
  cashDeltaCents: number;
  /** Dominant counter-account type (largest absolute non-cash line). */
  counterType: AccountType;
}

export interface CashFlow {
  fromCustomersCents: number;
  forJobsCents: number;
  forOverheadCents: number;
  ownerCents: number;
  taxesAndLoansCents: number;
  netChangeCents: number;
  explain: string;
}

const CF_BUCKET: Record<AccountType, keyof Omit<CashFlow, "netChangeCents" | "explain">> = {
  revenue: "fromCustomersCents",
  asset: "fromCustomersCents", // AR collections / deposits land here too
  cogs: "forJobsCents",
  expense: "forOverheadCents",
  equity: "ownerCents",
  liability: "taxesAndLoansCents",
};

/**
 * Direct-method cash flow: each entry that touches cash is bucketed by its
 * dominant counter-account type — except that money paid into job WIP
 * (asset 14xx) is job spend, not a customer movement; the store tags those
 * movements `cogs` before they reach here.
 */
export function buildCashFlow(movements: CashMovement[]): CashFlow {
  const flow: CashFlow = {
    fromCustomersCents: 0,
    forJobsCents: 0,
    forOverheadCents: 0,
    ownerCents: 0,
    taxesAndLoansCents: 0,
    netChangeCents: 0,
    explain: "",
  };
  for (const m of movements) {
    flow[CF_BUCKET[m.counterType]] += m.cashDeltaCents;
    flow.netChangeCents += m.cashDeltaCents;
  }
  flow.explain =
    flow.netChangeCents >= 0
      ? `Cash went up by ${dollars(flow.netChangeCents)} this period. ${dollars(flow.fromCustomersCents)} came in from customers; ${dollars(-flow.forJobsCents)} went out for job costs and ${dollars(-flow.forOverheadCents)} for running the business.`
      : `Cash went down by ${dollars(-flow.netChangeCents)} this period. ${dollars(flow.fromCustomersCents)} came in from customers, but ${dollars(-flow.forJobsCents)} went out for job costs and ${dollars(-flow.forOverheadCents)} for running the business.`;
  return flow;
}

// ------------------------------------------------------- Trial balance
export interface TrialBalance {
  rows: { code: string; name: string; debitCents: number; creditCents: number }[];
  totalDebitsCents: number;
  totalCreditsCents: number;
  ties: boolean;
  explain: string;
}

export function buildTrialBalance(balances: AccountBalance[]): TrialBalance {
  const rows = balances
    .filter((b) => b.balanceCents !== 0)
    .map((b) => ({
      code: b.code,
      name: b.name,
      debitCents: b.balanceCents > 0 ? b.balanceCents : 0,
      creditCents: b.balanceCents < 0 ? -b.balanceCents : 0,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const totalDebitsCents = rows.reduce((t, r) => t + r.debitCents, 0);
  const totalCreditsCents = rows.reduce((t, r) => t + r.creditCents, 0);
  const ties = totalDebitsCents === totalCreditsCents;
  const explain = ties
    ? `Every dollar is accounted for: ${dollars(totalDebitsCents)} on each side. Your books balance.`
    : `Warning: the two sides do not match (${dollars(totalDebitsCents)} vs ${dollars(totalCreditsCents)}). Something is wrong — call your bookkeeper.`;
  return { rows, totalDebitsCents, totalCreditsCents, ties, explain };
}
