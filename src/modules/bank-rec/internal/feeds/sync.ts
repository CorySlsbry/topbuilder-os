import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { encryptToken, decryptToken } from "@/lib/crypto/tokens";
import { HttpError } from "@/lib/http/errors";
import { DEFAULT_GL_BY_KIND } from "../store";
import { fingerprint, normalizeDescription, ruleMatcherFrom } from "../parse";
import { tryMatch } from "../match";
import { suspectPersonal } from "@/modules/job-costing";
import { tellerProvider } from "./teller";
import {
  FeedAuthError,
  FeedNotConfiguredError,
  type FeedProvider,
  type ProviderKey,
} from "./types";

export class FeedError extends HttpError {
  constructor(status: 404 | 409 | 422 | 503, code: string) {
    super(status, code);
  }
}

/**
 * The sync engine — provider-agnostic on purpose.
 *
 * Everything below works on the normalised shapes in ./types. Adding Plaid
 * alongside Teller is a new adapter file and one line in this registry.
 */
const PROVIDERS: Record<string, FeedProvider> = {
  teller: tellerProvider,
};

export function listProviders(): { key: string; label: string; configured: boolean }[] {
  return Object.values(PROVIDERS).map((p) => ({
    key: p.key,
    label: p.label,
    configured: p.isConfigured(),
  }));
}

function provider(key: string): FeedProvider {
  const p = PROVIDERS[key];
  if (!p) throw new FeedError(422, "unknown_provider");
  // Fails CLOSED. A connect button that appears and then errors on the first
  // call is worse than one that never appears.
  if (!p.isConfigured()) throw new FeedError(503, `provider_not_configured:${key}`);
  return p;
}

/**
 * ⛔ HOW FAR BACK EACH SYNC LOOKS, AND WHY IT IS NOT A HIGH-WATER MARK.
 *
 * Banks backdate. A transaction dated the 3rd can appear in the feed on the
 * 9th, and a cursor that only ever moves forward would skip it silently —
 * the worst possible failure, because the books look reconciled and are
 * short one transaction. Every sync re-reads this many days and relies on
 * the provider-transaction-id unique index to make re-reading free.
 */
const LOOKBACK_DAYS = 30;
/** First sync pulls real history so the shop has something to reconcile. */
const FIRST_SYNC_DAYS = 120;

export interface ConnectResult {
  connectionId: string;
  institution: string;
  accountsLinked: number;
  accountsSkipped: number;
}

/**
 * Store a proven connection and link its accounts.
 *
 * The token is validated against the provider BEFORE it is stored — a token
 * that was never proven is how a connection looks healthy on screen and
 * returns nothing for a week.
 */
export async function connectFeed(
  scope: TenantScope,
  providerKey: ProviderKey,
  publicToken: string,
): Promise<ConnectResult> {
  const p = provider(providerKey);

  let proven: { accessToken: string; institution: string; externalId: string };
  try {
    proven = await p.exchange(publicToken);
  } catch (e) {
    if (e instanceof FeedAuthError) throw new FeedError(422, "connection_rejected_by_bank");
    if (e instanceof FeedNotConfiguredError) throw new FeedError(503, "provider_not_configured");
    throw e;
  }

  const accounts = await p.listAccounts(proven.accessToken);

  return withTenant(scope, async (c) => {
    const conn = await c.query<{ id: string }>(
      `INSERT INTO feed_connections (tenant_id, provider, external_id, institution,
         access_token_enc, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'active',$6)
       ON CONFLICT (tenant_id, provider, external_id) DO UPDATE SET
         access_token_enc = EXCLUDED.access_token_enc,
         status = 'active', last_error = ''
       RETURNING id`,
      [
        scope.tenantId, providerKey, proven.externalId, proven.institution,
        // ⛔ The raw token never touches a column.
        encryptToken(proven.accessToken), scope.uid,
      ],
    );
    const connectionId = conn.rows[0]!.id;

    let linked = 0;
    let skipped = 0;
    for (const a of accounts) {
      const gl = DEFAULT_GL_BY_KIND[a.kind] ?? "1020";
      const exists = await c.query("SELECT 1 FROM chart_of_accounts WHERE code = $1", [gl]);
      if (exists.rowCount === 0) {
        // The chart has no home for this kind of account. Skipping is right:
        // linking it anyway would post a card to whatever code happened to
        // be the default, which is how card debt becomes negative cash.
        skipped += 1;
        continue;
      }
      const res = await c.query(
        `INSERT INTO bank_accounts (tenant_id, name, gl_account_code, institution, last4,
           kind, charges_are_positive, feed_connection_id, external_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8)
         ON CONFLICT (tenant_id, feed_connection_id, external_account_id) DO UPDATE SET
           name = EXCLUDED.name, institution = EXCLUDED.institution, is_active = true`,
        [
          scope.tenantId, a.name, gl, a.institution, a.last4, a.kind,
          connectionId, a.externalId,
        ],
      );
      linked += res.rowCount ?? 0;
    }

    return { connectionId, institution: proven.institution, accountsLinked: linked, accountsSkipped: skipped };
  });
}

export interface SyncResult {
  connectionId: string;
  institution: string;
  accountsSynced: number;
  newTransactions: number;
  duplicates: number;
  pendingSkipped: number;
  autoMatched: number;
  status: string;
}

/**
 * Pull one connection's transactions.
 *
 * Safe to run as often as you like: the provider's transaction id is unique
 * per tenant (migration 0055), so a re-sync of overlapping days inserts
 * nothing. That is what lets the lookback window be generous instead of
 * clever.
 */
export async function syncFeed(
  scope: TenantScope,
  connectionId: string,
): Promise<SyncResult> {
  const loaded = await withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      provider: string;
      institution: string;
      access_token_enc: string | null;
      synced_through: string | null;
    }>(
      `SELECT provider, institution, access_token_enc, synced_through::text
         FROM feed_connections WHERE id = $1`,
      [connectionId],
    );
    if (rows.length === 0) throw new FeedError(404, "connection_not_found");
    return rows[0]!;
  });

  if (!loaded.access_token_enc) throw new FeedError(422, "connection_has_no_token");
  const p = provider(loaded.provider);
  const accessToken = decryptToken(loaded.access_token_enc);

  const since = await withTenant(scope, async (c) => {
    const days = loaded.synced_through ? LOOKBACK_DAYS : FIRST_SYNC_DAYS;
    const { rows } = await c.query<{ d: string }>(
      "SELECT (CURRENT_DATE - $1::int)::text AS d",
      [days],
    );
    return rows[0]!.d;
  });

  // The accounts this connection owns, and what they are called here.
  const linked = await withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      id: string;
      external_account_id: string;
      charges_are_positive: boolean;
      gl_account_code: string;
    }>(
      `SELECT id, external_account_id, charges_are_positive, gl_account_code
         FROM bank_accounts
        WHERE feed_connection_id = $1 AND external_account_id IS NOT NULL AND is_active`,
      [connectionId],
    );
    return rows;
  });

  let newTransactions = 0;
  let duplicates = 0;
  let pendingSkipped = 0;
  let autoMatched = 0;
  let newest: string | null = null;

  try {
    for (const acct of linked) {
      const txns = await p.listTransactions(accessToken, acct.external_account_id, since);

      for (const t of txns) {
        // ⛔ PENDING NEVER ENTERS THE BOOKS. A $50 card authorisation that
        // settles at $47.80 is two transactions to a bank and one to a
        // human. Importing the pending one means the owner deletes a
        // duplicate by hand every week until they turn the feed off.
        if (t.pending) {
          pendingSkipped += 1;
          continue;
        }
        if (t.amountCents === 0) continue; // the amount CHECK refuses zero anyway

        const amount = acct.charges_are_positive ? -t.amountCents : t.amountCents;
        if (!newest || t.postedOn > newest) newest = t.postedOn;

        const inserted = await withTenant(scope, async (c) => {
          // A better description than the bank's raw string when the
          // provider resolved a merchant — "HOME DEPOT" beats
          // "HOMEDEPOT.COM 8009306161 GA".
          const description = t.merchant ? `${t.merchant} — ${t.description}` : t.description;
          const personal = amount < 0 ? suspectPersonal(description) : { suspect: false };
          const suggestion = await suggestRuleFor(c, description);

          const res = await c.query<{ id: string }>(
            `INSERT INTO bank_transactions
               (tenant_id, bank_account_id, posted_on, amount_cents, description,
                fingerprint, provider_txn_id, source, suggested_rule_id,
                personal_suspect, personal_reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'feed',$8,$9,$10)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [
              scope.tenantId, acct.id, t.postedOn, amount, description,
              // The fingerprint stays, so a line that arrives BOTH from a
              // CSV upload and from the feed is still caught. Two dedupe
              // keys, and either one is enough.
              fingerprint(acct.id, { postedOn: t.postedOn, amountCents: amount, description }),
              t.externalId, suggestion, personal.suspect, personal.reason ?? null,
            ],
          );
          return res.rows[0]?.id ?? null;
        });

        if (!inserted) {
          duplicates += 1;
          continue;
        }
        newTransactions += 1;

        // Match against money already on the books. ONE matcher, shared
        // with the file importer — two copies is how the feed's copy would
        // have kept the double-count bug after the importer's was fixed.
        const matched = await withTenant(scope, (c) =>
          tryMatch(c, {
            txnId: inserted,
            bankGlCode: acct.gl_account_code,
            amountCents: amount,
            postedOn: t.postedOn,
            uid: scope.uid,
          }),
        );
        if (matched) autoMatched += 1;
      }
    }
  } catch (e) {
    const needsReauth = e instanceof FeedAuthError;
    await withTenant(scope, async (c) => {
      await c.query(
        `UPDATE feed_connections
            SET status = $2, last_error = $3, last_synced_at = now()
          WHERE id = $1`,
        [
          connectionId,
          needsReauth ? "needs-reauth" : "error",
          (e as Error).message.slice(0, 400),
        ],
      );
    });
    if (needsReauth) throw new FeedError(409, "connection_needs_reauth");
    throw e;
  }

  await withTenant(scope, async (c) => {
    await c.query(
      `UPDATE feed_connections
          SET status = 'active', last_error = '', last_synced_at = now(),
              synced_through = COALESCE($2::date, synced_through),
              last_sync_new = $3, last_sync_duplicate = $4
        WHERE id = $1`,
      [connectionId, newest, newTransactions, duplicates],
    );
  });

  return {
    connectionId,
    institution: loaded.institution,
    accountsSynced: linked.length,
    newTransactions,
    duplicates,
    pendingSkipped,
    autoMatched,
    status: "active",
  };
}

async function suggestRuleFor(c: PoolClient, description: string): Promise<string | null> {
  const norm = normalizeDescription(description);
  const { rows } = await c.query<{ id: string; matcher: string }>(
    "SELECT id, matcher FROM bank_rules ORDER BY length(matcher) DESC",
  );
  return rows.find((r) => norm.includes(r.matcher))?.id ?? null;
}

export interface ConnectionRow {
  id: string;
  provider: string;
  institution: string;
  status: string;
  lastSyncedAt: string | null;
  lastError: string;
  lastSyncNew: number;
  lastSyncDuplicate: number;
  accountCount: number;
}

export async function listConnections(scope: TenantScope): Promise<ConnectionRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      id: string; provider: string; institution: string; status: string;
      last_synced_at: string | null; last_error: string;
      last_sync_new: number; last_sync_duplicate: number; n: string;
    }>(
      `SELECT f.id, f.provider, f.institution, f.status,
              f.last_synced_at::text, f.last_error,
              f.last_sync_new, f.last_sync_duplicate,
              COUNT(b.id) AS n
         FROM feed_connections f
         LEFT JOIN bank_accounts b ON b.feed_connection_id = f.id AND b.is_active
        GROUP BY f.id
        ORDER BY f.institution`,
    );
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      institution: r.institution,
      status: r.status,
      lastSyncedAt: r.last_synced_at,
      lastError: r.last_error,
      lastSyncNew: Number(r.last_sync_new),
      lastSyncDuplicate: Number(r.last_sync_duplicate),
      accountCount: Number(r.n),
    }));
  });
}

/**
 * Disconnect. The TOKEN goes; the transactions and their postings STAY.
 *
 * Deleting the history would delete a reconciled month and everything posted
 * from it. Disconnecting a feed is a decision about a data source, not a
 * decision to un-run the business.
 */
export async function disconnectFeed(scope: TenantScope, connectionId: string): Promise<void> {
  await withTenant(scope, async (c) => {
    await c.query(
      `UPDATE feed_connections
          SET status = 'revoked', access_token_enc = NULL, last_error = ''
        WHERE id = $1`,
      [connectionId],
    );
  });
}

export { ruleMatcherFrom };
