"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Preview {
  tenantName: string;
  rowCounts: { table: string; rows: number }[];
  totalRows: number;
}

export default function AccountPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [typed, setTyped] = useState("");
  const [stage, setStage] = useState<"idle" | "confirming">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notOwner, setNotOwner] = useState(false);
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      setPreview(await api<Preview>("/api/account/delete"));
        setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push("/login");
      else if (e instanceof ApiError && e.status === 403) setNotOwner(true);
      else setError("Couldn't load your account details.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function deleteEverything() {
    setBusy(true);
    setError("");
    try {
      await api("/api/account/delete", { method: "POST", json: { confirmName: typed } });
      router.push("/login?deleted=1");
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "name_mismatch"
          ? "That doesn't match your business name exactly — check the spelling."
          // Accurate now that the purge runs FIRST and in one transaction: if it
          // fails it rolls back whole, so nothing is half-deleted. Saying
          // "nothing was removed" was previously a lie whenever the Stripe
          // cancel had already gone through.
          : "Couldn't complete the deletion — your data is untouched. Give us a call.",
      );
      setBusy(false);
    }
  }

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Your data">
        {showSkeleton && <PageSkeleton kind="form" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Your data">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Download everything</h2>
        <p className="muted">
          One file with every record we hold for your business — jobs, customers,
          invoices, the full ledger, time, bank activity, all of it. One CSV per
          table, openable in Excel or handed straight to your accountant. This
          works whether or not you have a subscription, forever.
        </p>
        <a
          className="pill"
          style={{ padding: "10px 16px", textDecoration: "none", display: "inline-block" }}
          href="/api/account/export"
          download
        >
          ⬇ Download all my data (.zip)
        </a>
        <p className="muted" style={{ marginBottom: 0 }}>
          Want just the books in QuickBooks format? The{" "}
          <a href="/accountant">Accountant page</a> has the journal as CSV or IIF.
        </p>
      </div>

      {notOwner ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Only the owner can delete the business account.
          </p>
        </div>
      ) : (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <h2 style={{ marginTop: 0, color: "var(--danger)" }}>Delete everything</h2>
          <p>
            This erases your business from Top Builder OS — every job, invoice,
            journal entry, and person. It cancels your subscription. It cannot be
            undone, and we cannot bring it back for you afterward.
          </p>
          <p className="muted">
            <strong>Download your data first.</strong> Once this is done, the export
            button above has nothing left to give you.
          </p>
          {preview && preview.totalRows > 0 && (
            <p className="muted">
              You&apos;re about to delete <strong>{preview.totalRows.toLocaleString()}</strong> records
              across {preview.rowCounts.length} tables.
            </p>
          )}
          {stage === "idle" ? (
            <button className="secondary" onClick={() => setStage("confirming")}>
              I want to delete my account
            </button>
          ) : (
            <>
              <label htmlFor="confirm">
                Type your business name exactly — <strong>{preview?.tenantName}</strong> — to confirm
              </label>
              <input
                id="confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={preview?.tenantName ?? ""}
                autoComplete="off"
              />
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  disabled={busy || typed.trim() !== (preview?.tenantName ?? "").trim()}
                  style={{ background: "var(--danger)" }}
                  onClick={() => void deleteEverything()}
                >
                  Permanently delete everything
                </button>
                <button className="secondary" disabled={busy} onClick={() => setStage("idle")}>
                  Keep my account
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
