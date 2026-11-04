/**
 * The shape every bank-feed provider gets normalised into.
 *
 * ⛔ THE LEDGER MUST NEVER LEARN THE PROVIDER'S NAME. QuickBooks Online's own
 * feeds run on Plaid with Finicity behind them; nobody connects to seven
 * thousand banks directly, and which aggregator this product uses is a
 * commercial decision that WILL change. The CFPB's Section 1033 rewrite has
 * even reopened whether banks may charge for data access, so it may change
 * for reasons outside anyone's control.
 *
 * So a provider is an adapter that returns these three shapes and nothing
 * else. Adding Plaid alongside Teller is a new file, not a migration.
 */

export type ProviderKey = "teller" | "plaid" | "manual";

/** An account as the provider describes it, before we decide what it IS. */
export interface FeedAccount {
  /** The provider's stable id. */
  externalId: string;
  name: string;
  institution: string;
  /** Last four of the account or card number, when the provider gives it. */
  last4: string | null;
  /**
   * Normalised to this product's own vocabulary, because every provider has
   * its own. A credit card is a LIABILITY here and posting it as cash puts
   * card debt on the balance sheet as negative cash.
   */
  kind: "checking" | "savings" | "credit-card" | "line-of-credit" | "loan";
  /** Current balance in cents, signed the way THIS product means it: positive
   *  is money the shop has, negative is money the shop owes. Null when the
   *  provider did not return one. */
  balanceCents: number | null;
}

/**
 * One transaction, normalised.
 *
 * ⛔ SIGN CONVENTION, ONCE, HERE. Negative means the shop's position got
 * worse: money out of checking, or MORE owed on a card. Providers disagree
 * about this — some report a card purchase as positive because the balance
 * owed went up — so every adapter is responsible for flipping into this
 * convention and the rest of the system never thinks about it again.
 */
export interface FeedTransaction {
  /** The provider's stable id. THE dedupe key — see migration 0055. */
  externalId: string;
  accountExternalId: string;
  postedOn: string; // yyyy-mm-dd
  amountCents: number;
  description: string;
  /**
   * ⛔ PENDING TRANSACTIONS ARE NEVER IMPORTED, and this flag is how the
   * sync engine knows. A $50 card authorisation that settles at $47.80 with
   * a tip is TWO different transactions to a bank and one to a human; import
   * the pending one and the owner cleans up a duplicate by hand every week
   * until they turn the feed off. Waiting for `posted` costs a day and saves
   * the feature.
   */
  pending: boolean;
  /** The provider's own guess at a category. A HINT for the rule engine,
   *  never a posting decision — the human gate stays. */
  providerCategory: string | null;
  /** The merchant, when the provider resolves one. Better rule-matching
   *  material than a raw bank description full of store numbers. */
  merchant: string | null;
}

export interface FeedProvider {
  key: ProviderKey;
  label: string;
  /** Is this provider configured on THIS deployment? False means no keys. */
  isConfigured(): boolean;
  /**
   * Turn whatever the provider's front-end widget handed back into a
   * long-lived access token plus the institution's name.
   */
  exchange(publicToken: string): Promise<{ accessToken: string; institution: string; externalId: string }>;
  listAccounts(accessToken: string): Promise<FeedAccount[]>;
  /**
   * Transactions on one account since a date. `since` is a LOOKBACK, not a
   * high-water mark: banks backdate, and a cursor that only moves forward
   * silently loses anything that lands late.
   */
  listTransactions(
    accessToken: string,
    accountExternalId: string,
    since: string,
  ): Promise<FeedTransaction[]>;
}

/** Thrown when the enrollment needs the human to log in again. Distinguished
 *  from every other failure because the FIX is different: a re-auth prompt,
 *  not a retry. */
export class FeedAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedAuthError";
  }
}

/** Thrown when the provider is not configured on this deployment. */
export class FeedNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`${provider} is not configured on this deployment`);
    this.name = "FeedNotConfiguredError";
  }
}
