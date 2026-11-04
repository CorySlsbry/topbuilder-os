"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

/**
 * Connect a bank or credit card account.
 *
 * ⛔ THE CREDENTIALS NEVER TOUCH THIS APPLICATION. The provider's own widget
 * collects them in its own frame and hands back a token; this page never sees
 * a username, a password, or a one-time code, and there is no field on it
 * that could. That is the entire security argument for using an aggregator,
 * and it is worth stating on the page itself — a contractor about to type
 * their bank login somewhere deserves to be told who is asking.
 */

interface Provider {
  key: string;
  label: string;
  configured: boolean;
}

export default function ConnectPage() {
  const router = useRouter();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      const r = await api<{ providers: Provider[] }>("/api/bank/feeds");
      setProviders(r.providers.filter((p) => p.configured));
      setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.push("/login");
      } else {
        setError("Couldn't check which banks are available.");
        setLoaded(true);
      }
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Hand the provider's token to the server.
   *
   * The widget itself is loaded by the provider's own script, which the CSP
   * has to allow explicitly — until that is configured this page tells the
   * truth about it rather than rendering a button that does nothing.
   */
  async function finish(provider: string, publicToken: string) {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ institution: string; accountsLinked: number; accountsSkipped: number }>(
        "/api/bank/feeds",
        { method: "POST", json: { action: "connect", provider, publicToken } },
      );
      setNote(
        `Connected ${r.institution} — ${r.accountsLinked} account${r.accountsLinked === 1 ? "" : "s"} linked` +
          (r.accountsSkipped > 0
            ? `. ${r.accountsSkipped} were skipped because your chart of accounts has nowhere to put them yet.`
            : ". Head back to the bank screen and hit Sync now."),
      );
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "connection_rejected_by_bank"
          ? "The bank turned that connection down. Try connecting again."
          : e instanceof ApiError && e.status === 403
            ? "That needs 2-step verification — turn it on under Sign-in security."
            : "Couldn't finish connecting.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <AppShell title="Connect an account">
        {showSkeleton && <PageSkeleton kind="form" />}
      </AppShell>
    );
  }

  return (
    <AppShell title="Connect an account">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Your bank login never comes to us</h2>
        <p>
          Connecting runs through your bank&apos;s own sign-in, inside the
          provider&apos;s window. We receive a read-only token for
          <strong> transactions and balances</strong> — never your username,
          never your password, never a code. There is no field on this page
          that could take one.
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          The token is stored encrypted, and you can disconnect at any time
          from the bank screen. Disconnecting stops the sync; everything
          already on your books stays exactly where it is.
        </p>
      </div>

      {providers.length === 0 ? (
        <div className="card">
          <strong>Live feeds aren&apos;t switched on for this account yet.</strong>
          <p className="muted">
            <Link href="/bank">Uploading a statement</Link> works today and
            always will. That fallback is deliberate — it&apos;s what keeps
            working the week a bank feed goes down, which is the thing every
            contractor coming off QuickBooks has been burned by.
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            CSV, OFX and QFX all import, with no 24-month history limit.
          </p>
        </div>
      ) : (
        providers.map((p) => (
          <div key={p.key} className="card">
            <div className="row">
              <div className="grow">
                <strong>{p.label}</strong>
                <div className="muted">
                  Checking, savings and credit cards. Balances and posted
                  transactions only.
                </div>
              </div>
              <button
                disabled={busy}
                style={{ alignSelf: "center" }}
                onClick={() => {
                  // The provider's widget script is loaded from their domain
                  // and must be allowed by the CSP before this can open. Say
                  // so plainly rather than failing silently.
                  const w = (window as unknown as Record<string, unknown>)[
                    p.key === "teller" ? "TellerConnect" : "Plaid"
                  ];
                  if (!w) {
                    setError(
                      `${p.label}'s secure window isn't loaded on this page yet — that's a setup step on our side, not something wrong with your bank. Upload a statement in the meantime.`,
                    );
                    return;
                  }
                  setError("");
                  // The widget calls back with a token; nothing else here
                  // ever handles a credential.
                  (w as { setup: (o: unknown) => { open: () => void } })
                    .setup({
                      onSuccess: (res: { accessToken?: string; public_token?: string }) =>
                        void finish(p.key, res.accessToken ?? res.public_token ?? ""),
                      onExit: () => setBusy(false),
                    })
                    .open();
                }}
              >
                Connect with {p.label}
              </button>
            </div>
          </div>
        ))
      )}

      {note && <p className="muted" aria-live="polite">{note}</p>}
      {error && <p className="error" aria-live="polite">{error}</p>}
      <p className="muted">
        <Link href="/bank">← Back to the bank screen</Link>
      </p>
    </AppShell>
  );
}
