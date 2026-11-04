import "server-only";
import { request as httpsRequest } from "node:https";
import {
  FeedAuthError,
  FeedNotConfiguredError,
  type FeedAccount,
  type FeedProvider,
} from "./types";

/**
 * Teller — the first bank-feed provider.
 *
 * ── WHY TELLER FIRST ─────────────────────────────────────────────────────
 * It publishes its price ($0.30 per enrollment per month for transactions),
 * gives 100 free live connections, covers 5,000-7,000+ US institutions
 * including the ones a contractor actually banks with, supports CREDIT CARDS,
 * and connects through direct bank integrations rather than screen-scraping
 * where it can. Plaid has broader coverage and is what QuickBooks itself
 * runs on, but it is sales-led with a ~$9k median contract — a second
 * adapter to add when coverage bites, not the one to start on.
 *
 * ── mTLS IS NOT OPTIONAL IN PRODUCTION ───────────────────────────────────
 * Teller authenticates the SERVER with a client certificate, not just the
 * enrollment token. That is a genuinely better security posture than a
 * bearer token alone — a leaked token is useless without the private key —
 * and it is also the thing that most often gets skipped in development and
 * then fails on the first production call. So this fails CLOSED and loudly:
 * without a cert, `isConfigured()` is false and the connect button never
 * appears, rather than appearing and erroring at the worst moment.
 */

const BASE = "https://api.teller.io";

interface TellerAccount {
  id: string;
  name: string;
  type: string; // "depository" | "credit"
  subtype: string; // "checking" | "savings" | "credit_card" | ...
  last_four: string | null;
  institution: { id: string; name: string };
}

interface TellerBalance {
  available: string | null;
  ledger: string | null;
}

interface TellerTransaction {
  id: string;
  account_id: string;
  amount: string; // signed decimal STRING
  date: string; // yyyy-mm-dd
  description: string;
  status: "posted" | "pending";
  details?: {
    category?: string | null;
    counterparty?: { name?: string | null } | null;
  };
}

function certs(): { cert: string; key: string } | null {
  const cert = process.env.TELLER_CERT;
  const key = process.env.TELLER_KEY;
  if (!cert || !key) return null;
  // Secret Manager round-trips newlines as literal "\n" often enough that
  // not handling it is a guaranteed afternoon lost to an opaque TLS error.
  return { cert: cert.replace(/\\n/g, "\n"), key: key.replace(/\\n/g, "\n") };
}

/**
 * Cents from Teller's signed decimal string.
 *
 * ⛔ NOT `Math.round(Number(s) * 100)`. Floating point turns "10.07" into
 * 1006.9999999999999, and Math.round saves you on that one and not on the
 * next. Parse the string.
 */
export function tellerAmountToCents(amount: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) throw new Error(`unparseable Teller amount: ${amount}`);
  const [, sign, whole, frac = ""] = m;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return sign === "-" ? -cents : cents;
}

/** Teller's account taxonomy, mapped onto this product's own. */
export function tellerKind(type: string, subtype: string): FeedAccount["kind"] {
  if (type === "credit") return "credit-card";
  if (subtype === "savings" || subtype === "money_market") return "savings";
  return "checking";
}

/**
 * ⛔ NOT `fetch`. Node's global fetch is undici, and undici does not accept
 * node:https' `agent` option — it takes a `dispatcher`, and silently ignores
 * anything it does not recognise. The previous version passed
 * `agent: new HttpsAgent({cert, key})` alongside `dispatcher: undefined`,
 * which type-checked (behind a `@ts-expect-error`), started no TLS handshake
 * with a client certificate, and would have failed on the first production
 * call — the exact failure the doc comment above says this design prevents.
 *
 * `node:https` takes `cert`/`key` directly, presents them, and adds no
 * dependency. The whole surface is three JSON GETs; that does not justify
 * pulling undici in as a userland package just to reach its Agent.
 */
const TIMEOUT_MS = 20_000;

function requestJson(
  path: string,
  accessToken: string,
  c: { cert: string; key: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      `${BASE}${path}`,
      {
        method: "GET",
        cert: c.cert,
        key: c.key,
        headers: {
          // Teller uses HTTP Basic with the access token as the USERNAME and
          // an empty password.
          authorization: `Basic ${Buffer.from(`${accessToken}:`).toString("base64")}`,
          accept: "application/json",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    // A bank that accepts the connection and then stops talking would
    // otherwise hold a Cloud Run request open until the platform kills it.
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("Teller timed out")));
    req.on("error", reject);
    req.end();
  });
}

async function call<T>(path: string, accessToken: string): Promise<T> {
  const c = certs();
  if (!c) throw new FeedNotConfiguredError("Teller");

  const res = await requestJson(path, accessToken, c);

  if (res.status === 401 || res.status === 403) {
    // The enrollment is dead — the customer changed their password, revoked
    // access, or the bank forced a re-login. A retry cannot fix this and the
    // caller must show a re-connect prompt, so it gets its own error type.
    throw new FeedAuthError(`Teller returned ${res.status} — the connection needs to be re-authorised`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Teller ${path} failed: ${res.status} ${res.body.slice(0, 300)}`);
  }
  return JSON.parse(res.body) as T;
}

export const tellerProvider: FeedProvider = {
  key: "teller",
  label: "Teller",

  isConfigured() {
    return certs() !== null;
  },

  /**
   * Teller Connect hands the BROWSER a long-lived access token directly —
   * there is no separate public-token exchange step the way Plaid has one.
   * The "exchange" here is therefore a validation call: prove the token
   * works and learn which institution it belongs to before storing it.
   * Storing a token that was never proven is how a connection looks healthy
   * on screen and returns nothing for a week.
   */
  async exchange(accessToken: string) {
    const accounts = await call<TellerAccount[]>("/accounts", accessToken);
    if (accounts.length === 0) {
      throw new Error("that connection has no accounts on it");
    }
    return {
      accessToken,
      institution: accounts[0]!.institution.name,
      externalId: accounts[0]!.institution.id,
    };
  },

  async listAccounts(accessToken) {
    const accounts = await call<TellerAccount[]>("/accounts", accessToken);
    const out: FeedAccount[] = [];
    for (const a of accounts) {
      let balanceCents: number | null = null;
      try {
        const b = await call<TellerBalance>(`/accounts/${a.id}/balances`, accessToken);
        const raw = b.ledger ?? b.available;
        if (raw) {
          const cents = tellerAmountToCents(raw);
          // Teller reports a credit-card balance as a POSITIVE number meaning
          // "this much is owed". This product means "positive is money the
          // shop has", so a card balance flips.
          balanceCents = a.type === "credit" ? -Math.abs(cents) : cents;
        }
      } catch {
        // A balance is a nice-to-have. Losing it must not lose the account.
      }
      out.push({
        externalId: a.id,
        name: a.name,
        institution: a.institution.name,
        last4: a.last_four,
        kind: tellerKind(a.type, a.subtype),
        balanceCents,
      });
    }
    return out;
  },

  /**
   * ⛔ PAGINATED. `?count=500` alone returns the 500 NEWEST transactions and
   * nothing else. A first connection asking for two years of history on a
   * busy operating account silently receives a few months, and the shop
   * reconciles against a book that is missing the rest — with no error, no
   * warning, and a plausible-looking result.
   *
   * Teller pages newest-first with `from_id`, which returns the page OLDER
   * than that id. So: walk back until a page starts before `since`, or the
   * page comes back short (that is the end of the account's history).
   */
  async listTransactions(accessToken, accountExternalId, since) {
    const PAGE = 500;
    const MAX_PAGES = 40; // 20,000 transactions; see the warning below
    const txns: TellerTransaction[] = [];
    let fromId: string | null = null;
    let page = 0;

    for (; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ count: String(PAGE) });
      if (fromId) q.set("from_id", fromId);
      const batch = await call<TellerTransaction[]>(
        `/accounts/${accountExternalId}/transactions?${q.toString()}`,
        accessToken,
      );
      if (batch.length === 0) break;
      txns.push(...batch);

      const oldest = batch[batch.length - 1]!;
      // Walked past the window we were asked for, or ran out of history.
      if (oldest.date < since || batch.length < PAGE) break;
      fromId = oldest.id;
    }

    if (page === MAX_PAGES) {
      // Say so out loud. A cap that truncates quietly reads downstream as
      // "this is the whole account", which is the same lie the un-paginated
      // version told.
      console.warn(
        `[teller] account ${accountExternalId}: stopped at ${MAX_PAGES * PAGE} transactions before reaching ${since}; the earliest history was not fetched`,
      );
    }

    return txns
      .filter((t) => t.date >= since)
      .map((t) => ({
        externalId: t.id,
        accountExternalId: t.account_id,
        postedOn: t.date,
        // Teller already signs money-out negative on both depository and
        // credit accounts, which is this product's convention — so no flip.
        // Asserted by a unit test rather than trusted, because a silent
        // change here inverts every transaction in the shop.
        amountCents: tellerAmountToCents(t.amount),
        description: t.description,
        pending: t.status !== "posted",
        providerCategory: t.details?.category ?? null,
        merchant: t.details?.counterparty?.name ?? null,
      }));
  },
};
