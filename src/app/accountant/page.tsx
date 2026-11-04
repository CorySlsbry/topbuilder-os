"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";
import {
  api,
  ApiError,
  centsFromInput,
  dollars,
  newIdempotencyKey,
} from "@/lib/client/api";

interface Status {
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
interface ImportReport {
  accountsMapped: number;
  accountsUnmapped: { qboId: string; qboName: string; qboType: string }[];
  customersImported: number;
  openingEntryId: string | null;
  openingDebitsCents: number;
  diffs: { accountCode: string; oursCents: number; theirsCents: number }[];
  verified: boolean;
}
interface SyncReport {
  pushed: number;
  skipped: number;
  blocked: { entryId: string; missingCodes: string[] }[];
}
interface JeLine {
  account: string;
  side: "debit" | "credit";
  amount: string;
}
interface InvoiceRow {
  id: string;
  invoiceNo: number;
  customerId: string;
  customerName: string;
  about: string;
  openCents: number;
  status: string;
}
interface MemoRow {
  id: string;
  memoNo: number;
  customerName: string;
  invoiceNo: number | null;
  reason: string;
  amountCents: number;
  status: string;
}

export default function AccountantPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [syncReport, setSyncReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  // Adjusting journal entry — the bookkeeper's pen.
  const [jeMemo, setJeMemo] = useState("");
  const [jeDate, setJeDate] = useState(today);
  const [jeReverse, setJeReverse] = useState("");
  const [jeLines, setJeLines] = useState<JeLine[]>([
    { account: "", side: "debit", amount: "" },
    { account: "", side: "credit", amount: "" },
  ]);
  const [jeNote, setJeNote] = useState("");
  // Credit memos & voids.
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [memos, setMemos] = useState<MemoRow[]>([]);
  const [cmInvoice, setCmInvoice] = useState("");
  const [cmAmount, setCmAmount] = useState("");
  const [cmReason, setCmReason] = useState("");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      setStatus(await api<Status>("/api/qbo/status"));
      const [inv, cm] = await Promise.all([
        api<{ invoices: InvoiceRow[] }>("/api/invoices").catch(() => ({ invoices: [] })),
        api<{ creditMemos: MemoRow[] }>("/api/credit-memos").catch(() => ({ creditMemos: [] })),
      ]);
      setInvoices(inv.invoices);
      setMemos(cm.creditMemos);
        setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load the accountant screen.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "missing_env:QBO_CLIENT_ID"
          ? "QuickBooks keys aren't set up yet — this unlocks when Intuit credentials land."
          : "That didn't work — try again.",
      );
      return null;
    } finally {
      setBusy(false);
      await load();
    }
  }

  // --- adjusting entry math: live balance so the CPA sees drift instantly
  const drTotal = jeLines.reduce(
    (t, l) => t + (l.side === "debit" ? (centsFromInput(l.amount) ?? 0) : 0), 0);
  const crTotal = jeLines.reduce(
    (t, l) => t + (l.side === "credit" ? (centsFromInput(l.amount) ?? 0) : 0), 0);
  const jeBalanced = drTotal > 0 && drTotal === crTotal;
  const jeReady =
    jeBalanced && jeMemo.trim().length > 0 &&
    jeLines.every((l) => !l.amount || l.account.trim());

  async function postJe() {
    setBusy(true);
    setError("");
    setJeNote("");
    try {
      const lines = jeLines
        .filter((l) => (centsFromInput(l.amount) ?? 0) > 0)
        .map((l) => ({
          accountCode: l.account.trim(),
          ...(l.side === "debit"
            ? { debitCents: centsFromInput(l.amount)! }
            : { creditCents: centsFromInput(l.amount)! }),
        }));
      const r = await api<{ journalEntryId: string; reversalEntryId: string | null }>(
        "/api/ledger/journal-entries",
        {
          method: "POST",
          idempotencyKey: newIdempotencyKey(),
          json: {
            occurredOn: jeDate,
            memo: jeMemo.trim(),
            lines,
            ...(jeReverse ? { autoReverseOn: jeReverse } : {}),
          },
        },
      );
      setJeNote(
        r.reversalEntryId
          ? "Posted, with the reversal dated " + jeReverse + " already in."
          : "Posted.",
      );
      setJeMemo("");
      setJeLines([
        { account: "", side: "debit", amount: "" },
        { account: "", side: "credit", amount: "" },
      ]);
      setJeReverse("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't post the entry.");
    } finally {
      setBusy(false);
    }
  }

  async function createMemo() {
    const cents = centsFromInput(cmAmount);
    const inv = invoices.find((i) => i.id === cmInvoice);
    if (!inv || cents === null || cents <= 0 || !cmReason.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/credit-memos", {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        json: {
          customerId: inv.customerId,
          invoiceId: inv.id,
          amountCents: cents,
          reason: cmReason.trim(),
          issuedOn: today,
        },
      });
      setJeNote(`Credit posted against invoice #${inv.invoiceNo}.`);
      setCmAmount("");
      setCmReason("");
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't post the credit.");
    } finally {
      setBusy(false);
    }
  }

  async function voidInv(id: string, no: number) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/invoices/${id}/void`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        json: { voidedOn: today },
      });
      setJeNote(`Invoice #${no} voided — exact reversal posted today.`);
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "invoice_has_payments"
          ? "That invoice has money against it — use a credit memo instead; voiding is only for unpaid ones."
          : e instanceof ApiError ? e.message : "Couldn't void it.",
      );
    } finally {
      setBusy(false);
    }
  }

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Accountant">
        {showSkeleton && <PageSkeleton kind="detail" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Your accountant">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Your books leave with you — always</h2>
        <p className="muted">
          One click exports your entire journal. No lock-in, no request form,
          no waiting. This works forever, whether or not you stay with us.
        </p>
        <div className="row">
          <a className="pill" style={{ padding: "10px 14px", textDecoration: "none" }} href="/api/export/journal?format=csv" download>
            ⬇ Journal CSV (QBO-importable)
          </a>
          <a className="pill" style={{ padding: "10px 14px", textDecoration: "none" }} href="/api/export/journal?format=iif" download>
            ⬇ Journal IIF (QuickBooks Desktop)
          </a>
          <Link className="pill" style={{ padding: "10px 14px", textDecoration: "none" }} href="/reports">
            📦 CPA pack (statements + GL)
          </Link>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await api<{ code: string }>("/api/advisor", {
                  method: "POST",
                  json: { action: "create-invite" },
                });
                await navigator.clipboard.writeText(r.code).catch(() => {});
                setInviteCode(r.code);
                return r;
              })
            }
          >
            🤝 Invite my CPA
          </button>
        </div>
        {inviteCode && (
          <p className="muted" style={{ marginBottom: 0, wordBreak: "break-all" }}>
            One-time code (copied): <strong>{inviteCode}</strong> — your CPA
            pastes it at /advisor and gets read-and-reconcile access, free.
          </p>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>QuickBooks connection</h2>
        {!status?.connected ? (
          <>
            <p className="muted">
              Two uses, both optional: <strong>switching to us?</strong> We pull
              your books out of QuickBooks and verify every balance to the
              penny. <strong>Your CPA lives in QuickBooks?</strong> We push a
              copy of your ledger into their file on a schedule — you never
              open QuickBooks again, and they keep working the way they like.
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const r = await api<{ url: string }>("/api/qbo/connect", { method: "POST", json: {} });
                  window.location.href = r.url;
                })
              }
            >
              Connect QuickBooks
            </button>
          </>
        ) : (
          <>
            <p>
              Connected to company <strong>{status.realmId}</strong> ({status.environment}) —{" "}
              {status.status === "healthy" ? "healthy" : status.status}
              {status.lastError ? ` · last error: ${status.lastError}` : ""}
            </p>

            <h3>1 · Bring my books over (switching)</h3>
            <p className="muted">
              Pulls your chart of accounts, customers, and balances, then
              checks every number against QuickBooks. To the penny, or we tell
              you exactly what's off.
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => setReport(await api<ImportReport>("/api/qbo/import", { method: "POST", json: { asOf: today } })))
              }
            >
              Run migration
            </button>
            {report && (
              <div style={{ marginTop: 10 }}>
                <p>
                  {report.verified ? "✅ Verified to the penny." : "⚠ Needs attention."}{" "}
                  {report.accountsMapped} accounts mapped, {report.customersImported} customers
                  imported, opening entry {dollars(report.openingDebitsCents)} each side.
                </p>
                {report.accountsUnmapped.length > 0 && (
                  <p className="error">
                    Unmapped accounts (tell us where these go):{" "}
                    {report.accountsUnmapped.map((u) => u.qboName).join(", ")}
                  </p>
                )}
                {report.diffs.length > 0 && (
                  <p className="error">
                    Balance differences: {report.diffs.map((d) => `${d.accountCode} (ours ${dollars(d.oursCents)} vs theirs ${dollars(d.theirsCents)})`).join(", ")}
                  </p>
                )}
              </div>
            )}

            <h3>2 · Keep my CPA's QuickBooks up to date</h3>
            <p className="muted">
              One-way: our ledger is the book of record; the QuickBooks copy is
              for your CPA's convenience. {status.pushedCount} entries pushed
              {status.lastPushedAt ? `, last on ${status.lastPushedAt.slice(0, 10)}` : ""}.
            </p>
            <div className="row">
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(() => api("/api/qbo/sync", { method: "POST", json: { action: "enable", enabled: !status.syncEnabled } }))
                }
              >
                {status.syncEnabled ? "Turn sync off" : "Turn sync on"}
              </button>
              <button
                disabled={busy || !status.syncEnabled}
                onClick={() => void act(async () => setSyncReport(await api<SyncReport>("/api/qbo/sync", { method: "POST", json: { action: "run" } })))}
              >
                Push now
              </button>
              <button className="secondary" disabled={busy} onClick={() => void act(() => api("/api/qbo/disconnect", { method: "POST", json: {} }))}>
                Disconnect
              </button>
            </div>
            {syncReport && (
              <p style={{ marginTop: 8 }}>
                Pushed {syncReport.pushed}, skipped {syncReport.skipped} (already there)
                {syncReport.blocked.length > 0 && (
                  <span className="error"> · {syncReport.blocked.length} blocked on unmapped accounts — run the migration step first.</span>
                )}
              </p>
            )}
          </>
        )}
      </div>

      {/* --------------------------------------------- adjusting entries */}
      <h2>Adjusting journal entry</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          The bookkeeper&apos;s pen: depreciation, accruals, reclasses. Posts
          straight to the ledger, immutable once in — corrections are new
          entries, never edits. Needs 2-step verification, like everything
          that moves money.
        </p>
        <div className="row" style={{ alignItems: "end", flexWrap: "wrap" }}>
          <div className="grow">
            <label htmlFor="je-memo">What is this entry?</label>
            <input id="je-memo" value={jeMemo} onChange={(e) => setJeMemo(e.target.value.slice(0, 300))} placeholder="December depreciation — service vans" />
          </div>
          <div>
            <label htmlFor="je-date">Dated</label>
            <input id="je-date" type="date" value={jeDate} onChange={(e) => setJeDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor="je-rev">Auto-reverse on (optional)</label>
            <input id="je-rev" type="date" value={jeReverse} onChange={(e) => setJeReverse(e.target.value)} />
          </div>
        </div>
        {jeLines.map((l, i) => (
          <div key={i} className="row" style={{ marginTop: 6, alignItems: "end" }}>
            <div>
              <label htmlFor={`je-a-${i}`}>Account</label>
              <input id={`je-a-${i}`} value={l.account} style={{ width: 110 }} placeholder="8310"
                onChange={(e) => setJeLines((cur) => cur.map((x, j) => (j === i ? { ...x, account: e.target.value.slice(0, 20) } : x)))} />
            </div>
            <div>
              <label htmlFor={`je-s-${i}`}>Side</label>
              <select id={`je-s-${i}`} value={l.side}
                onChange={(e) => setJeLines((cur) => cur.map((x, j) => (j === i ? { ...x, side: e.target.value as "debit" | "credit" } : x)))}>
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
              </select>
            </div>
            <div>
              <label htmlFor={`je-m-${i}`}>Amount</label>
              <input id={`je-m-${i}`} value={l.amount} inputMode="decimal" style={{ width: 120 }} placeholder="$450.00"
                onChange={(e) => setJeLines((cur) => cur.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
            </div>
            {jeLines.length > 2 && (
              <button className="secondary" style={{ minHeight: 34, padding: "4px 10px" }}
                onClick={() => setJeLines((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>
                ✕
              </button>
            )}
          </div>
        ))}
        <div className="row" style={{ marginTop: 10, alignItems: "center" }}>
          <button className="secondary" style={{ minHeight: 34, padding: "4px 12px" }}
            onClick={() => setJeLines((cur) => [...cur, { account: "", side: "credit", amount: "" }])}>
            + Line
          </button>
          <span className={jeBalanced ? "gain" : "muted"}>
            DR {dollars(drTotal)} · CR {dollars(crTotal)}
            {jeBalanced ? " — balanced ✓" : drTotal + crTotal > 0 ? ` — off by ${dollars(Math.abs(drTotal - crTotal))}` : ""}
          </span>
          <button disabled={busy || !jeReady} onClick={() => void postJe()}>
            Post entry
          </button>
          {!jeReady && (drTotal > 0 || crTotal > 0) && (
            <span className="muted" style={{ fontSize: "0.9rem" }}>
              {!jeMemo.trim() ? "Still needs a description" : !jeBalanced ? "Debits must equal credits" : "Every amount needs an account"}
            </span>
          )}
        </div>
      </div>

      {/* ------------------------------------------- credit memos & voids */}
      <h2>Credit memos &amp; voids</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Take a sale back, honestly. A <strong>credit memo</strong> reduces
          what a customer owes on an open invoice; <strong>void</strong> is for
          unpaid invoices that shouldn&apos;t exist — it posts the exact
          reversal, dated today. Money already collected? Credit memo first,
          then refund it from the list below.
        </p>
        <div className="row" style={{ alignItems: "end", flexWrap: "wrap" }}>
          <div className="grow">
            <label htmlFor="cm-inv">Invoice</label>
            <select id="cm-inv" value={cmInvoice} onChange={(e) => setCmInvoice(e.target.value)}>
              <option value="">— pick an open invoice —</option>
              {invoices.filter((i) => i.status === "issued" || i.status === "partial").map((i) => (
                <option key={i.id} value={i.id}>
                  #{i.invoiceNo} · {i.customerName} · {i.about} · {dollars(i.openCents)} open
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="cm-amt">Credit</label>
            <input id="cm-amt" value={cmAmount} inputMode="decimal" style={{ width: 120 }} placeholder="$150.00"
              onChange={(e) => setCmAmount(e.target.value)} />
          </div>
          <div className="grow">
            <label htmlFor="cm-why">Why (goes on the record)</label>
            <input id="cm-why" value={cmReason} onChange={(e) => setCmReason(e.target.value.slice(0, 300))} placeholder="Goodwill — callback on the condenser" />
          </div>
          <button disabled={busy || !cmInvoice || !cmReason.trim() || !(centsFromInput(cmAmount) ?? 0)} onClick={() => void createMemo()}>
            Post credit
          </button>
          {cmInvoice && (
            <button className="secondary" disabled={busy}
              onClick={() => { const inv = invoices.find((i) => i.id === cmInvoice); if (inv) void voidInv(inv.id, inv.invoiceNo); }}>
              Void this invoice
            </button>
          )}
        </div>
        {memos.length > 0 && (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr><th>Memo</th><th>Customer</th><th>Reason</th><th>Amount</th><th>Status</th></tr>
            </thead>
            <tbody>
              {memos.map((m) => (
                <tr key={m.id}>
                  <td>#{m.memoNo}{m.invoiceNo ? ` → inv #${m.invoiceNo}` : " (on account)"}</td>
                  <td>{m.customerName}</td>
                  <td className="muted">{m.reason}</td>
                  <td>{dollars(m.amountCents)}</td>
                  <td>{m.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div role="status" aria-live="polite">
        {jeNote && <p className="gain">{jeNote}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </AppShell>
  );
}
