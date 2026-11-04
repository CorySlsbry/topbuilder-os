"use client";
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";
import {
  api,
  ApiError,
  centsFromInput,
  dollars,
  newIdempotencyKey,
} from "@/lib/client/api";

interface BillLine {
  lineNo: number;
  description: string;
  amountCents: number;
  jobId: string | null;
  jobName: string | null;
  costCode: string | null;
  accountCode: string | null;
}
interface BillPayment {
  id: string;
  paidOn: string;
  amountCents: number;
  method: string;
  reference: string | null;
  createdBy: string;
}
interface Bill {
  id: string;
  vendorName: string;
  vendorIs1099: boolean;
  billRef: string;
  issuedOn: string;
  dueOn: string | null;
  memo: string;
  totalCents: number;
  paidCents: number;
  status: string;
  lines: BillLine[];
  payments: BillPayment[];
}

const METHODS = [
  { key: "check", label: "Check" },
  { key: "ach", label: "Bank transfer (ACH)" },
  { key: "card", label: "Card" },
  { key: "cash", label: "Cash" },
] as const;

export default function BillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [bill, setBill] = useState<Bill | null>(null);
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<string>("check");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(bill !== null);

  const load = useCallback(async () => {
    try {
      const b = await api<Bill>(`/api/bills/${id}`);
      setBill(b);
      // Default to the full remaining balance — paying in full is the common
      // case, and it stays editable for the times it isn't.
      setAmount(((b.totalCents - b.paidCents) / 100).toFixed(2));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load that bill.");
    }
  }, [id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!bill) {
    return (
      <AppShell title="Bill">
        {showSkeleton && <PageSkeleton kind="detail" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  const remaining = bill.totalCents - bill.paidCents;
  const cents = centsFromInput(amount);
  const overpay = cents !== null && cents > remaining;
  const blockers = [
    cents === null && "an amount",
    cents !== null && cents <= 0 && "an amount above zero",
    !paidOn && "a date",
  ].filter(Boolean) as string[];

  async function record() {
    if (cents === null || overpay || blockers.length > 0) return;
    setBusy(true);
    setError("");
    // One key per ATTEMPT AT THIS PAYMENT, generated here rather than inside
    // the fetch helper. If the response is lost to a dropped connection and
    // the user taps again, the retry carries the same key and the server
    // replays the first result instead of paying the vendor twice.
    const key = newIdempotencyKey();
    try {
      await api(`/api/bills/${bill!.id}/pay`, {
        method: "POST",
        idempotencyKey: key,
        json: {
          paidOn,
          amountCents: cents,
          method,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        },
      });
      setReference("");
      setNote(
        cents >= remaining
          ? "Recorded in full. The ledger and the bank plane both know."
          : `Recorded ${dollars(cents)}. ${dollars(remaining - cents)} still open.`,
      );
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "amount_exceeds_remaining"
          ? "That's more than the bill still has open."
          : "Couldn't record that payment.",
      );
    }
    setBusy(false);
  }

  return (
    <AppShell title={`${bill.vendorName} — ${bill.memo || bill.billRef}`}>
      <p style={{ marginTop: 0 }}>
        <Link href="/purchasing">← Purchasing &amp; bills</Link>
      </p>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "start" }}>
          <div>
            <h2 style={{ marginTop: 0, marginBottom: 4 }}>{bill.vendorName}</h2>
            <p className="muted" style={{ margin: 0 }}>
              {bill.billRef ? `Ref ${bill.billRef} · ` : ""}Issued {bill.issuedOn}
              {bill.dueOn ? ` · Due ${bill.dueOn}` : ""}
              {bill.vendorIs1099 ? " · 1099 vendor" : ""}
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "1.6rem", fontWeight: 600 }}>{dollars(remaining)}</div>
            <div className="muted">
              still open of {dollars(bill.totalCents)}
              {bill.paidCents > 0 ? ` · ${dollars(bill.paidCents)} paid` : ""}
            </div>
          </div>
        </div>
      </div>

      <h2>What it was for</h2>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th>Job</th>
              <th>Code</th>
              <th style={{ textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.lineNo}>
                <td>{l.description || "—"}</td>
                <td>
                  {l.jobId ? (
                    <Link href={`/jobs/${l.jobId}`}>{l.jobName ?? "job"}</Link>
                  ) : (
                    <span className="muted">overhead</span>
                  )}
                </td>
                <td className="muted">{l.costCode ?? l.accountCode ?? "—"}</td>
                <td style={{ textAlign: "right" }}>{dollars(l.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {bill.payments.length > 0 && (
        <>
          <h2>Payments so far</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {bill.payments.map((p) => (
                  <tr key={p.id}>
                    <td>{p.paidOn}</td>
                    <td>{METHODS.find((m) => m.key === p.method)?.label ?? p.method}</td>
                    <td className="muted">{p.reference || "—"}</td>
                    <td style={{ textAlign: "right" }}>{dollars(p.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {remaining > 0 ? (
        <>
          <h2>Record a payment</h2>
          <div className="card">
            {/*
              ⚠️ WORDING IS LOAD-BEARING HERE. This records that you paid; it
              does not move money. The old button said "Pay in full", which
              reads like the software pays the vendor — it does not, any more
              than QuickBooks' Pay Bills does. Someone trusting that wording
              would think a supplier had been paid when no cheque had been
              written, and find out from the supplier.
            */}
            <p className="muted" style={{ marginTop: 0 }}>
              This writes the payment into your books. It does <strong>not</strong> send
              money — pay the vendor however you normally do, then record it here so the
              bank reconciliation matches.
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                gap: 12,
                alignItems: "end",
              }}
            >
              <div>
                <label htmlFor="amt">Amount</label>
                <input
                  id="amt"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  aria-invalid={overpay || cents === null}
                />
              </div>
              <div>
                <label htmlFor="paidon">Date paid</label>
                <input
                  id="paidon"
                  type="date"
                  value={paidOn}
                  onChange={(e) => setPaidOn(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="meth">How</label>
                <select id="meth" value={method} onChange={(e) => setMethod(e.target.value)}>
                  {METHODS.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ref">
                  {method === "check" ? "Check number" : "Reference"}
                </label>
                <input
                  id="ref"
                  value={reference}
                  onChange={(e) => setReference(e.target.value.slice(0, 60))}
                  placeholder={method === "check" ? "4471" : "optional"}
                />
              </div>
            </div>

            <div className="row" style={{ marginTop: 8, gap: 8 }}>
              <button
                className="secondary"
                style={{ minHeight: 34, padding: "4px 12px" }}
                onClick={() => setAmount((remaining / 100).toFixed(2))}
              >
                Full balance
              </button>
              <button
                className="secondary"
                style={{ minHeight: 34, padding: "4px 12px" }}
                onClick={() => setAmount((Math.round(remaining / 2) / 100).toFixed(2))}
              >
                Half
              </button>
            </div>

            <div className="row" style={{ marginTop: 14, alignItems: "center" }}>
              <button disabled={busy || overpay || blockers.length > 0} onClick={() => void record()}>
                {busy ? "Recording…" : "Record payment"}
              </button>
              <span className="muted" style={{ fontSize: "0.9rem" }}>
                {overpay
                  ? `That's more than the ${dollars(remaining)} still open`
                  : blockers.length > 0
                    ? `Still needs ${blockers.join(" and ")}`
                    : cents !== null && cents < remaining
                      ? `Leaves ${dollars(remaining - cents)} open`
                      : "Clears this bill"}
              </span>
            </div>
          </div>
        </>
      ) : (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Paid in full ✅</h2>
          <p className="muted" style={{ margin: 0 }}>
            Nothing left open on this bill.
          </p>
        </div>
      )}

      <div role="status" aria-live="polite">
        {note && <p className="gain">{note}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </AppShell>
  );
}
