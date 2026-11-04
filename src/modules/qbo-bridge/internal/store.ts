import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { postJournalEntry } from "@/modules/ledger";
import { getGlDetail } from "@/modules/reporting";
import { decryptToken, encryptToken } from "./crypto";
import {
  buildOpeningEntry,
  mapQboAccounts,
  qboAmountToCents,
  type MappingResult,
  type QboAccount,
  type QboTbRow,
} from "./mapping";
import { planSyncBatch } from "./syncplan";

export class QboError extends HttpError {
  constructor(status: 400 | 404 | 409 | 422 | 502, code: string) {
    super(status, code);
  }
}

const OAUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SANDBOX_API = "https://sandbox-quickbooks.api.intuit.com";
const PROD_API = "https://quickbooks.api.intuit.com";
const MINOR = "75";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new QboError(422, `missing_env:${name}`);
  return v;
}

function qboEnv(): "sandbox" | "production" {
  return process.env.QBO_ENV === "production" ? "production" : "sandbox";
}

// ------------------------------------------------------------------ OAuth
// state = tenantId.nonce.hmac — verified on callback so a forged redirect
// can't attach someone else's realm to a tenant.
function stateSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new QboError(422, "missing_env:SESSION_SECRET");
  }
  // Same dev/test fallback as the session layer — never reachable in prod.
  return "dev-only-insecure-session-secret-0000000000";
}

function signState(tenantId: string, nonce: string): string {
  const mac = createHmac("sha256", stateSecret())
    .update(`${tenantId}.${nonce}`)
    .digest("base64url");
  return `${tenantId}.${nonce}.${mac}`;
}

export function buildAuthorizeUrl(scope: TenantScope): string {
  const state = signState(scope.tenantId, randomBytes(12).toString("base64url"));
  const q = new URLSearchParams({
    client_id: env("QBO_CLIENT_ID"),
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: env("QBO_REDIRECT_URI"),
    state,
  });
  return `${OAUTH_BASE}?${q}`;
}

export function verifyState(state: string): string {
  const [tenantId, nonce, mac] = state.split(".");
  if (!tenantId || !nonce || !mac) throw new QboError(400, "bad_state");
  const expected = createHmac("sha256", stateSecret())
    .update(`${tenantId}.${nonce}`)
    .digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new QboError(400, "bad_state");
  }
  return tenantId;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}

async function exchangeToken(body: URLSearchParams): Promise<TokenResponse> {
  const basic = Buffer.from(`${env("QBO_CLIENT_ID")}:${env("QBO_CLIENT_SECRET")}`).toString(
    "base64",
  );
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) throw new QboError(502, `oauth_exchange_failed:${res.status}`);
  return (await res.json()) as TokenResponse;
}

export async function completeConnection(
  scope: TenantScope,
  code: string,
  realmId: string,
): Promise<void> {
  const tok = await exchangeToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: env("QBO_REDIRECT_URI"),
    }),
  );
  await withTenant(scope, async (c) => {
    await c.query(
      `INSERT INTO qbo_connections
         (tenant_id, realm_id, environment, access_token_enc, refresh_token_enc,
          access_expires_at, refresh_expires_at, status, connected_by)
       VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval,
               now() + ($7 || ' seconds')::interval, 'healthy', $8)
       ON CONFLICT (tenant_id) DO UPDATE SET
         realm_id = EXCLUDED.realm_id,
         environment = EXCLUDED.environment,
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         access_expires_at = EXCLUDED.access_expires_at,
         refresh_expires_at = EXCLUDED.refresh_expires_at,
         status = 'healthy', last_error = NULL, updated_at = now()`,
      [
        scope.tenantId,
        realmId,
        qboEnv(),
        encryptToken(tok.access_token),
        encryptToken(tok.refresh_token),
        String(tok.expires_in),
        String(tok.x_refresh_token_expires_in),
        scope.uid,
      ],
    );
    await c.query(
      `INSERT INTO qbo_sync_state (tenant_id) VALUES ($1)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [scope.tenantId],
    );
  });
}

export interface QboStatus {
  connected: boolean;
  realmId: string | null;
  environment: string | null;
  status: string | null;
  syncEnabled: boolean;
  refreshExpiresAt: string | null;
  cursor: string | null;
  pushedCount: number;
  lastPushedAt: string | null;
  lastError: string | null;
}

export async function getQboStatus(scope: TenantScope): Promise<QboStatus> {
  return withTenant(scope, async (c) => {
    // Never select the token columns here — status only.
    const conn = await c.query<{
      realm_id: string;
      environment: string;
      status: string;
      sync_enabled: boolean;
      refresh_expires_at: string;
      last_error: string | null;
    }>(
      `SELECT realm_id, environment, status, sync_enabled,
              refresh_expires_at::text AS refresh_expires_at, last_error
         FROM qbo_connections WHERE status <> 'disconnected'`,
    );
    const st = await c.query<{
      cursor: string;
      pushed_count: string;
      last_pushed_at: string | null;
    }>(
      `SELECT cursor::text AS cursor, pushed_count, last_pushed_at::text AS last_pushed_at
         FROM qbo_sync_state`,
    );
    const r = conn.rows[0];
    const s = st.rows[0];
    return {
      connected: !!r,
      realmId: r?.realm_id ?? null,
      environment: r?.environment ?? null,
      status: r?.status ?? null,
      syncEnabled: r?.sync_enabled ?? false,
      refreshExpiresAt: r?.refresh_expires_at ?? null,
      cursor: s?.cursor ?? null,
      pushedCount: s ? Number(s.pushed_count) : 0,
      lastPushedAt: s?.last_pushed_at ?? null,
      lastError: r?.last_error ?? null,
    };
  });
}

export async function disconnectQbo(scope: TenantScope): Promise<void> {
  await withTenant(scope, async (c) => {
    await c.query(
      `UPDATE qbo_connections SET status = 'disconnected',
              access_token_enc = 'revoked', refresh_token_enc = 'revoked',
              sync_enabled = false, updated_at = now()`,
    );
  });
}

export async function setSyncEnabled(scope: TenantScope, enabled: boolean): Promise<void> {
  await withTenant(scope, async (c) => {
    const r = await c.query(
      `UPDATE qbo_connections SET sync_enabled = $1, updated_at = now()
        WHERE status <> 'disconnected'`,
      [enabled],
    );
    if (r.rowCount === 0) throw new QboError(404, "not_connected");
  });
}

// ------------------------------------------------------------- API client
interface LiveConnection {
  realmId: string;
  environment: string;
  accessToken: string;
}

async function liveConnection(scope: TenantScope): Promise<LiveConnection> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      realm_id: string;
      environment: string;
      access_token_enc: string;
      refresh_token_enc: string;
      access_expires_at: string;
    }>(
      `SELECT realm_id, environment, access_token_enc, refresh_token_enc,
              access_expires_at::text AS access_expires_at
         FROM qbo_connections WHERE status <> 'disconnected'`,
    );
    const r = rows[0];
    if (!r) throw new QboError(404, "not_connected");
    if (Date.parse(r.access_expires_at) > Date.now() + 5 * 60 * 1000) {
      return {
        realmId: r.realm_id,
        environment: r.environment,
        accessToken: decryptToken(r.access_token_enc),
      };
    }
    const tok = await exchangeToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: decryptToken(r.refresh_token_enc),
      }),
    );
    await c.query(
      `UPDATE qbo_connections SET
         access_token_enc = $1, refresh_token_enc = $2,
         access_expires_at = now() + ($3 || ' seconds')::interval,
         refresh_expires_at = now() + ($4 || ' seconds')::interval,
         status = 'healthy', last_error = NULL, updated_at = now()`,
      [
        encryptToken(tok.access_token),
        encryptToken(tok.refresh_token),
        String(tok.expires_in),
        String(tok.x_refresh_token_expires_in),
      ],
    );
    return {
      realmId: r.realm_id,
      environment: r.environment,
      accessToken: tok.access_token,
    };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function qboRequest<T>(
  conn: LiveConnection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const base = conn.environment === "production" ? PROD_API : SANDBOX_API;
  let attempt = 0;
  for (;;) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${conn.accessToken}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && attempt < 4) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? 1);
      await sleep(Math.max(retryAfter * 1000, 500 * 2 ** attempt));
      attempt++;
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(500 * 2 ** attempt);
      attempt++;
      continue;
    }
    if (!res.ok) throw new QboError(502, `qbo_api:${res.status}`);
    return (await res.json()) as T;
  }
}

async function qboQueryAll<T>(conn: LiveConnection, entity: string): Promise<T[]> {
  const all: T[] = [];
  const page = 1000;
  for (let start = 1; start < 1_000_000; start += page) {
    const sql = `SELECT * FROM ${entity} STARTPOSITION ${start} MAXRESULTS ${page}`;
    const r = await qboRequest<{ QueryResponse: Record<string, unknown> }>(
      conn,
      "GET",
      `/v3/company/${conn.realmId}/query?query=${encodeURIComponent(sql)}&minorversion=${MINOR}`,
    );
    const rows = Object.values(r.QueryResponse).find(Array.isArray) as T[] | undefined;
    all.push(...(rows ?? []));
    if (!rows || rows.length < page) break;
  }
  return all;
}

// ------------------------------------------------------------ migration-in
export interface ImportReport {
  accountsMapped: number;
  accountsUnmapped: MappingResult["unmapped"];
  customersImported: number;
  openingEntryId: string | null;
  openingDebitsCents: number;
  /** Our TB delta vs the QBO TB, per account — [] means to-the-penny. */
  diffs: { accountCode: string; oursCents: number; theirsCents: number }[];
  verified: boolean;
}

/**
 * Migration-in: map their COA onto NAHB, import customers, post their
 * trial balance as ONE opening journal entry, then verify our resulting
 * balances against the source to the penny. Anything unmapped or
 * mismatched is reported, never swallowed.
 */
export async function runQboImport(
  scope: TenantScope,
  asOf: string,
): Promise<ImportReport> {
  const conn = await liveConnection(scope);
  const qboAccounts = await qboQueryAll<QboAccount>(conn, "Account");
  const qboCustomers = await qboQueryAll<{
    Id: string;
    DisplayName: string;
    PrimaryEmailAddr?: { Address: string };
    PrimaryPhone?: { FreeFormNumber: string };
  }>(conn, "Customer");

  return withTenant(scope, async (c) => {
    const chart = await c.query<{ code: string; name: string; type: string }>(
      "SELECT code, name, type FROM chart_of_accounts WHERE is_active",
    );
    const mapping = mapQboAccounts(
      qboAccounts,
      chart.rows as { code: string; name: string; type: never }[],
    );

    // Entity-map accounts (idempotent) — also powers the Accountant Sync.
    for (const m of mapping.mapped) {
      await c.query(
        `INSERT INTO qbo_entity_map (tenant_id, local_type, local_id, qbo_type, qbo_id)
         VALUES ($1, 'account', $2, 'Account', $3)
         ON CONFLICT (tenant_id, qbo_type, qbo_id) DO NOTHING`,
        [scope.tenantId, m.nahbCode, m.qboId],
      );
    }

    // Customers (idempotent by entity map).
    let customersImported = 0;
    for (const cust of qboCustomers) {
      const seen = await c.query(
        `SELECT 1 FROM qbo_entity_map
          WHERE local_type = 'customer' AND qbo_type = 'Customer' AND qbo_id = $1`,
        [cust.Id],
      );
      if (seen.rows.length > 0) continue;
      const ins = await c.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, name, email, phone)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [
          scope.tenantId,
          cust.DisplayName,
          cust.PrimaryEmailAddr?.Address ?? null,
          cust.PrimaryPhone?.FreeFormNumber ?? null,
        ],
      );
      await c.query(
        `INSERT INTO qbo_entity_map (tenant_id, local_type, local_id, qbo_type, qbo_id)
         VALUES ($1, 'customer', $2, 'Customer', $3)`,
        [scope.tenantId, ins.rows[0]!.id, cust.Id],
      );
      customersImported++;
    }

    // Their balances (Account.CurrentBalance is signed by classification;
    // normalize to debit-positive cents).
    const tb: QboTbRow[] = qboAccounts
      .filter((a) => a.CurrentBalance !== undefined && a.CurrentBalance !== 0)
      .map((a) => {
        const cents = qboAmountToCents(a.CurrentBalance);
        const creditSide =
          a.Classification === "Liability" ||
          a.Classification === "Equity" ||
          a.Classification === "Revenue";
        return { qboAccountId: a.Id, balanceCents: creditSide ? -cents : cents };
      });

    const opening = buildOpeningEntry(tb, mapping.mapped);
    if (!opening.balanced) throw new QboError(422, "source_tb_unbalanced");

    let openingEntryId: string | null = null;
    if (opening.lines.length > 0) {
      const already = await c.query(
        `SELECT local_id FROM qbo_entity_map
          WHERE local_type = 'opening-entry' AND qbo_type = 'TrialBalance'`,
      );
      if (already.rows.length > 0) {
        openingEntryId = (already.rows[0] as { local_id: string }).local_id;
      } else {
        openingEntryId = await postJournalEntry(scope, {
          occurredOn: asOf,
          memo: "Opening balances migrated from QuickBooks Online",
          sourceType: "qbo-import",
          sourceId: conn.realmId,
          lines: opening.lines.map((l) => ({
            accountCode: l.accountCode,
            debitCents: l.debitCents,
            creditCents: l.creditCents,
          })),
        });
        await c.query(
          `INSERT INTO qbo_entity_map (tenant_id, local_type, local_id, qbo_type, qbo_id)
           VALUES ($1, 'opening-entry', $2, 'TrialBalance', $3)`,
          [scope.tenantId, openingEntryId, `opening-${conn.realmId}`],
        );
      }
    }

    // Verify to the penny: our per-account balances vs the mapped source.
    const ours = await c.query<{ code: string; bal: string }>(
      `SELECT a.code, COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint AS bal
         FROM chart_of_accounts a
         JOIN journal_lines l ON l.account_id = a.id
        GROUP BY a.code`,
    );
    const oursByCode = new Map(ours.rows.map((r) => [r.code, Number(r.bal)]));
    const theirs = buildOpeningEntry(tb, mapping.mapped);
    const diffs: ImportReport["diffs"] = [];
    for (const l of theirs.lines) {
      const our = oursByCode.get(l.accountCode) ?? 0;
      const their = l.debitCents - l.creditCents;
      if (our !== their) {
        diffs.push({ accountCode: l.accountCode, oursCents: our, theirsCents: their });
      }
    }

    return {
      accountsMapped: mapping.mapped.length,
      accountsUnmapped: mapping.unmapped,
      customersImported,
      openingEntryId,
      openingDebitsCents: opening.totalDebitsCents,
      diffs,
      verified: diffs.length === 0 && mapping.unmapped.length === 0,
    };
  });
}

// --------------------------------------------------------- Accountant Sync
export interface SyncReport {
  pushed: number;
  skipped: number;
  blocked: { entryId: string; missingCodes: string[] }[];
}

/**
 * One-way push of OUR ledger into the accountant's QBO file. CREATE-only
 * (our journal is append-only, corrections are reversing entries), doubly
 * idempotent: entity-map skip + requestid dedupe on QBO's side.
 */
export async function runAccountantSync(scope: TenantScope): Promise<SyncReport> {
  const conn = await liveConnection(scope);

  const { cursorRows, pushedSet, accountIdByCode } = await withTenant(scope, async (c) => {
    const enabled = await c.query<{ sync_enabled: boolean }>(
      `SELECT sync_enabled FROM qbo_connections WHERE status <> 'disconnected'`,
    );
    if (!enabled.rows[0]?.sync_enabled) throw new QboError(409, "sync_not_enabled");
    const st = await c.query<{ cursor: string }>(
      `SELECT cursor::text AS cursor FROM qbo_sync_state`,
    );
    const cursor = st.rows[0]?.cursor ?? "1970-01-01";
    const entries = await c.query<{ id: string; created_at: string }>(
      `SELECT id, created_at::text AS created_at FROM journal_entries
        WHERE created_at > $1 ORDER BY created_at LIMIT 200`,
      [cursor],
    );
    const pushed = await c.query<{ local_id: string }>(
      `SELECT local_id FROM qbo_entity_map
        WHERE local_type = 'journal-entry' AND qbo_type = 'JournalEntry'`,
    );
    const acctMap = await c.query<{ local_id: string; qbo_id: string }>(
      `SELECT local_id, qbo_id FROM qbo_entity_map
        WHERE local_type = 'account' AND qbo_type = 'Account'`,
    );
    return {
      cursorRows: entries.rows,
      pushedSet: new Set(pushed.rows.map((r) => r.local_id)),
      accountIdByCode: new Map(acctMap.rows.map((r) => [r.local_id, r.qbo_id])),
    };
  });

  if (cursorRows.length === 0) return { pushed: 0, skipped: 0, blocked: [] };

  const gl = await getGlDetail(scope, { to: "9999-12-31" });
  const wanted = new Set(cursorRows.map((r) => r.id));
  const rows = gl.filter((r) => wanted.has(r.entryId));
  const plan = planSyncBatch(rows, pushedSet, accountIdByCode);

  let pushedCount = 0;
  for (const item of plan.items) {
    const res = await qboRequest<{ JournalEntry: { Id: string; SyncToken: string } }>(
      conn,
      "POST",
      `/v3/company/${conn.realmId}/journalentry?minorversion=${MINOR}&requestid=${item.requestId}`,
      item.payload,
    );
    await withTenant(scope, async (c) => {
      await c.query(
        `INSERT INTO qbo_entity_map
           (tenant_id, local_type, local_id, qbo_type, qbo_id, qbo_sync_token)
         VALUES ($1, 'journal-entry', $2, 'JournalEntry', $3, $4)
         ON CONFLICT (tenant_id, local_type, local_id) DO NOTHING`,
        [scope.tenantId, item.localEntryId, res.JournalEntry.Id, res.JournalEntry.SyncToken],
      );
    });
    pushedCount++;
  }

  // Advance the cursor only past entries that are fully handled (pushed or
  // previously pushed). Blocked entries hold the cursor so they retry after
  // the account map is completed.
  const blockedIds = new Set(plan.blocked.map((b) => b.entryId));
  let newCursor: string | null = null;
  for (const e of cursorRows) {
    if (blockedIds.has(e.id)) break;
    newCursor = e.created_at;
  }
  await withTenant(scope, async (c) => {
    await c.query(
      `UPDATE qbo_sync_state SET
         cursor = COALESCE($1::timestamptz, cursor),
         last_pushed_at = CASE WHEN $2 > 0 THEN now() ELSE last_pushed_at END,
         pushed_count = pushed_count + $2,
         status = CASE WHEN $3 THEN 'error' ELSE 'idle' END,
         updated_at = now()`,
      [newCursor, pushedCount, plan.blocked.length > 0],
    );
  });

  return {
    pushed: pushedCount,
    skipped: plan.items.length - pushedCount + (cursorRows.length - plan.items.length - plan.blocked.length),
    blocked: plan.blocked,
  };
}

// ------------------------------------------------------------- export data
export async function getExportRows(scope: TenantScope, from: string | null, to: string) {
  return getGlDetail(scope, { from, to });
}
