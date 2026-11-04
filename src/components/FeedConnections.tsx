"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";

/**
 * Connected bank and credit card accounts.
 *
 * ── WHAT "EASY TO USE" MEANS HERE ────────────────────────────────────────
 * Three states, and the screen is honest about which one it is in:
 *   1. No provider configured on this deployment — say so, and point at the
 *      thing that DOES work (upload a statement) rather than showing a
 *      button that errors.
 *   2. Nothing connected — one button.
 *   3. Connected — the health of each connection, in words. "Synced 20
 *      minutes ago, 12 new" beats a green dot, and "this connection needs
 *      you to log in again" beats a red one, because only one of those tells
 *      you what to do.
 *
 * The failure mode this is designed against is QuickBooks': a feed that
 * breaks quietly, shows a status nobody can act on, and leaves the owner
 * assuming their books are current when they are three weeks stale.
 */

interface Connection {
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
interface Provider {
  key: string;
  label: string;
  configured: boolean;
}

/** "20 minutes ago" — a bare timestamp makes a person do the arithmetic. */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso.replace(" ", "T")).getTime();
  if (Number.isNaN(then)) return iso;
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export default function FeedConnections({ onChanged }: { onChanged: () => void }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api<{ connections: Connection[]; providers: Provider[] }>("/api/bank/feeds");
      setConnections(r.connections);
      setProviders(r.providers);
      setLoaded(true);
    } catch {
      // A feed panel that fails must not take the bank screen down with it —
      // uploading a statement has to keep working.
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync(conn: Connection) {
    setBusy(conn.id);
    setError("");
    setNote("");
    try {
      const r = await api<{
        newTransactions: number;
        duplicates: number;
        pendingSkipped: number;
        autoMatched: number;
      }>("/api/bank/feeds", { method: "POST", json: { action: "sync", connectionId: conn.id } });
      setNote(
        r.newTransactions === 0
          ? `${conn.institution}: nothing new. ${r.duplicates} transaction${r.duplicates === 1 ? " was" : "s were"} already here.` +
            (r.pendingSkipped > 0
              ? ` ${r.pendingSkipped} still pending at the bank — they'll come in once they post.`
              : "")
          : `${conn.institution}: ${r.newTransactions} new transaction${r.newTransactions === 1 ? "" : "s"}` +
            (r.autoMatched > 0 ? `, ${r.autoMatched} matched your books automatically` : "") +
            (r.pendingSkipped > 0 ? `. ${r.pendingSkipped} still pending at the bank.` : "."),
      );
      await load();
      onChanged();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "connection_needs_reauth"
          ? `${conn.institution} needs you to sign in again — the bank ended the connection.`
          : `Couldn't sync ${conn.institution}. Your statement upload still works.`,
      );
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(conn: Connection) {
    setBusy(conn.id);
    setError("");
    try {
      await api("/api/bank/feeds", {
        method: "POST",
        json: { action: "disconnect", connectionId: conn.id },
      });
      setNote(
        `Disconnected ${conn.institution}. Everything already imported stays exactly where it is — disconnecting a feed is a decision about a data source, not about your books.`,
      );
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 403
          ? "That needs 2-step verification — turn it on under Sign-in security."
          : "Couldn't disconnect that.",
      );
    } finally {
      setBusy(null);
    }
  }

  if (!loaded) return null;

  const available = providers.filter((p) => p.configured);
  const live = connections.filter((c) => c.status !== "revoked");

  return (
    <div className="card">
      <div className="row">
        <div className="grow">
          <strong>Connected accounts</strong>
          <div className="muted">
            {live.length === 0
              ? "Your checking and credit card accounts, syncing on their own."
              : `${live.length} connection${live.length === 1 ? "" : "s"} · ${live.reduce((t, c) => t + c.accountCount, 0)} account${live.reduce((t, c) => t + c.accountCount, 0) === 1 ? "" : "s"}`}
          </div>
        </div>
        {available.length > 0 && (
          <a
            className="pill"
            style={{ padding: "10px 14px", alignSelf: "center" }}
            href="/bank/connect"
          >
            + Connect an account
          </a>
        )}
      </div>

      {available.length === 0 && (
        <p className="muted" style={{ marginBottom: 0 }}>
          Live bank feeds aren&apos;t switched on for this account yet. Uploading
          a statement works today and always will — it&apos;s the fallback that
          keeps working the week a feed goes down, which is the thing every
          contractor has been burned by at least once.
        </p>
      )}

      {live.map((c) => (
        <div key={c.id} className="row" style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
          <div className="grow">
            <strong>{c.institution}</strong>{" "}
            <span className="muted">
              {c.accountCount} account{c.accountCount === 1 ? "" : "s"}
            </span>
            <div className="muted">
              {c.status === "needs-reauth" ? (
                <>
                  <strong>Needs you to sign in again.</strong> The bank ended the
                  connection — this happens after a password change. Reconnect
                  and nothing is lost.
                </>
              ) : c.status === "error" ? (
                <>
                  Last sync failed {ago(c.lastSyncedAt)}.{" "}
                  {c.lastError ? c.lastError.slice(0, 120) : "Try again, or upload a statement."}
                </>
              ) : (
                <>
                  Synced {ago(c.lastSyncedAt)}
                  {c.lastSyncNew > 0 ? ` · ${c.lastSyncNew} new last time` : ""}
                </>
              )}
            </div>
          </div>
          {c.status === "needs-reauth" ? (
            <a className="pill" style={{ padding: "8px 12px", alignSelf: "center" }} href="/bank/connect">
              Reconnect
            </a>
          ) : (
            <button
              className="secondary"
              disabled={busy !== null}
              onClick={() => void sync(c)}
              style={{ alignSelf: "center" }}
            >
              {busy === c.id ? "Syncing…" : "Sync now"}
            </button>
          )}
          <button
            className="secondary"
            disabled={busy !== null}
            onClick={() => void disconnect(c)}
            style={{ alignSelf: "center" }}
          >
            Disconnect
          </button>
        </div>
      ))}

      {note && <p className="muted" aria-live="polite">{note}</p>}
      {error && <p className="error" aria-live="polite">{error}</p>}
    </div>
  );
}
