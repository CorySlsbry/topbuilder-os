"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import CostCodeSelect, { type CostCodeOption } from "@/components/CostCodeSelect";
import { useRouter } from "next/navigation";
import { api, ApiError, centsFromInput, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Vendor {
  id: string;
  name: string;
  is1099: boolean;
  defaultAccountCode: string | null;
}
interface Bill {
  id: string;
  vendorName: string;
  billRef: string;
  issuedOn: string;
  dueOn: string | null;
  memo: string;
  totalCents: number;
  paidCents: number;
  status: string;
}
interface JobRow {
  id: string;
  jobNo: number;
  name: string;
}
interface Ten99 {
  vendorId: string;
  vendorName: string;
  taxIdLast4: string | null;
  paidCents: number;
  reportable: boolean;
}

export default function PurchasingPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [ten99, setTen99] = useState<Ten99[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  // new vendor
  const [vName, setVName] = useState("");
  const [v1099, setV1099] = useState(false);
  // new bill
  const [bVendor, setBVendor] = useState("");
  const [bAmount, setBAmount] = useState("");
  const [bMemo, setBMemo] = useState("");
  const [bJob, setBJob] = useState("");
  const [bAccount, setBAccount] = useState("");
  // Was hardcoded "4100"/"material" on every job-costed bill line.
  const [bCode, setBCode] = useState("");
  const [bKind, setBKind] = useState("material");
  const [costCodes, setCostCodes] = useState<CostCodeOption[]>([]);
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      const [v, b, j, t, cc] = await Promise.all([
        api<{ vendors: Vendor[] }>("/api/vendors"),
        api<{ bills: Bill[] }>("/api/bills"),
        api<{ jobs: JobRow[] }>("/api/jobs"),
        api<{ vendors: Ten99[] }>(`/api/reports/1099?year=${new Date().getFullYear()}`),
        api<{ costCodes: CostCodeOption[] }>("/api/cost-codes"),
      ]);
      setVendors(v.vendors);
      setBills(b.bills);
      setJobs(j.jobs);
      setTen99(t.vendors);
      setCostCodes(cc.costCodes);
      setBCode((cur) => cur || cc.costCodes[0]?.code || "");
      setBVendor((cur) => cur || v.vendors[0]?.id || "");
        setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load purchasing.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>, okNote?: string) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await fn();
      if (okNote) setNote(okNote);
    } catch {
      setError("That didn't work — check the fields and try again.");
    } finally {
      setBusy(false);
      await load();
    }
  }

  // Was Math.round(Number(...) * 100) — the same binary-drift trap fixed on
  // the estimate screen. A bill amount feeds AP and job cost, so a cent lost
  // here is a cent the bank reconciliation will never explain.
  const cents = (s: string) => centsFromInput(s) ?? 0;
  const today = new Date().toISOString().slice(0, 10);

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Purchasing">
        {showSkeleton && <PageSkeleton kind="table" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Purchasing & bills">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>What you owe</h2>
        {bills.filter((b) => b.status === "open" || b.status === "partial").length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No open bills. When a PO arrives, the Paperwork helper can draft
            the bill for you — approve it under Helpers.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Bill</th>
                <th>Due</th>
                <th>Open</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {bills
                .filter((b) => b.status === "open" || b.status === "partial")
                .map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/purchasing/${b.id}`}>{b.vendorName}</Link>
                    </td>
                    <td>{b.memo || b.billRef || b.issuedOn}</td>
                    <td>{b.dueOn ?? "—"}</td>
                    <td>
                      {dollars(b.totalCents - b.paidCents)}
                      {b.paidCents > 0 && (
                        <span className="muted" style={{ fontSize: "0.8rem" }}>
                          {" "}of {dollars(b.totalCents)}
                        </span>
                      )}
                    </td>
                    <td>
                      {/*
                        "Record payment", not "Pay in full".
                        Nothing here moves money — it writes the payment into
                        the books, the same as QuickBooks' Pay Bills. The old
                        label read as though the software paid the supplier,
                        which is the kind of wording someone finds out is wrong
                        from the supplier.
                      */}
                      <Link href={`/purchasing/${b.id}`}>
                        <button className="secondary" disabled={busy}>
                          Record payment
                        </button>
                      </Link>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Enter a bill</h2>
      <div className="card">
        <div className="row">
          <div>
            <label htmlFor="bv">Vendor</label>
            <select id="bv" value={bVendor} onChange={(e) => setBVendor(e.target.value)}>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="bam">Amount</label>
            <input id="bam" value={bAmount} onChange={(e) => setBAmount(e.target.value)} placeholder="1,250.00" />
          </div>
          <div className="grow">
            <label htmlFor="bm">What for</label>
            <input id="bm" value={bMemo} onChange={(e) => setBMemo(e.target.value)} placeholder="Shingles for the Smith job" />
          </div>
        </div>
        <div className="row">
          <div>
            <label htmlFor="bj">Job (or leave off)</label>
            <select id="bj" value={bJob} onChange={(e) => setBJob(e.target.value)}>
              <option value="">— overhead, not a job —</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>#{j.jobNo} {j.name}</option>
              ))}
            </select>
          </div>
          {bJob ? (
            <div className="grow">
              <label htmlFor="bcode">Cost code</label>
              <CostCodeSelect
                id="bcode"
                costCodes={costCodes}
                value={bCode}
                onChange={setBCode}
                onKind={setBKind}
              />
            </div>
          ) : (
            <div>
              <label htmlFor="ba">Expense account</label>
              <input id="ba" value={bAccount} onChange={(e) => setBAccount(e.target.value)} placeholder="8310" style={{ width: 110 }} />
            </div>
          )}
          <button
            style={{ alignSelf: "flex-end" }}
            disabled={busy || !bVendor || !bAmount || (bJob ? !bCode : !bAccount)}
            onClick={() =>
              void act(
                () =>
                  api("/api/bills", {
                    method: "POST",
                    json: {
                      vendorId: bVendor,
                      issuedOn: today,
                      memo: bMemo,
                      lines: [
                        bJob
                          ? { amountCents: cents(bAmount), jobId: bJob, costCode: bCode, costKind: bKind, description: bMemo }
                          : { amountCents: cents(bAmount), accountCode: bAccount.trim(), description: bMemo },
                      ],
                    },
                  }),
                "Bill entered — it's on your books as owed.",
              )
            }
          >
            Enter bill
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          On a job, it lands in that job&apos;s costs. Off a job, it&apos;s
          overhead. Either way it shows in &quot;what you owe&quot; until paid.
        </p>
      </div>

      <h2>Vendors</h2>
      <div className="card">
        <div className="row">
          <input value={vName} onChange={(e) => setVName(e.target.value)} placeholder="ABC Supply" aria-label="Vendor name" />
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={v1099} onChange={(e) => setV1099(e.target.checked)} />
            1099 (sub or contractor)
          </label>
          <button
            disabled={busy || !vName.trim()}
            onClick={() =>
              void act(
                () => api("/api/vendors", { method: "POST", json: { name: vName.trim(), is1099: v1099 } }),
                "Vendor added.",
              ).then(() => setVName(""))
            }
          >
            Add vendor
          </button>
        </div>
        {vendors.length > 0 && (
          <p className="muted" style={{ marginBottom: 0 }}>
            {vendors.map((v) => `${v.name}${v.is1099 ? " (1099)" : ""}`).join(" · ")}
          </p>
        )}
      </div>

      <h2>1099 tracker ({new Date().getFullYear()})</h2>
      <div className="card">
        {ten99.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Mark a vendor as 1099 and every payment to them is tracked here.
            At year end, this list is your 1099-NEC prep — no January scramble.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Paid this year</th>
                <th>1099 needed?</th>
              </tr>
            </thead>
            <tbody>
              {ten99.map((t) => (
                <tr key={t.vendorId}>
                  <td>{t.vendorName}{t.taxIdLast4 ? ` (…${t.taxIdLast4})` : ""}</td>
                  <td>{dollars(t.paidCents)}</td>
                  <td>{t.reportable ? "Yes — over $600" : "Not yet"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
