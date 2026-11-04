"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Costing {
  jobId: string;
  jobNo: number;
  name: string;
  status: string;
  contractCents: number;
  budgetCents: number;
  costsCents: number;
  etcCents: number | null;
  billedCents: number;
  wip: {
    pctCompleteBps: number;
    earnedRevenueCents: number;
    grossProfitCents: number;
    underbilledCents: number;
    overbilledCents: number;
    flags: { staleEtc: boolean; lossJob: boolean; billedPastContract: boolean; zeroEstimate: boolean };
  };
  committed: {
    committedCents: number;
    remainingCents: number;
    projectedFloorCents: number;
    overCommitted: boolean;
  };
  costsByCode: { costCode: string; kind: string; amountCents: number }[];
  purchaseOrders: { id: string; kind: string; vendorName: string; description: string; amountCents: number; status: string }[];
  explain: { wip: string; committed: string };
}

interface Profit {
  view: "full" | "crew";
  profit: {
    billedCents: number;
    collectedCents: number;
    totalCostsCents: number;
    billedProfitCents: number;
    billedMarginBps: number;
    collectedProfitCents: number;
    flags: {
      unpostedLaborPresent: boolean;
      noBillingYet: boolean;
      noCollectionYet: boolean;
      underwater: boolean;
    };
  };
  explain: string;
  wip: { grossProfitCents: number; pctCompleteBps: number; explain: string };
  unpostedLabor: { totalCents: number; workerCount: number } | null;
}

function Bar({ pctBps, warn }: { pctBps: number; warn?: boolean }) {
  const pct = Math.min(100, Math.round(pctBps / 100));
  return (
    <div style={{ background: "#ece9e2", borderRadius: 6, height: 14, overflow: "hidden" }}>
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: warn ? "var(--danger)" : "var(--brand)",
          transition: "width .3s",
        }}
      />
    </div>
  );
}

export default function JobMoneyPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [c, setC] = useState<Costing | null>(null);
  const [p, setP] = useState<Profit | null>(null);
  const [etc, setEtc] = useState("");
  const [poVendor, setPoVendor] = useState("");
  const [poAmount, setPoAmount] = useState("");
  const [poKind, setPoKind] = useState("po");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(c !== null);

  const load = useCallback(async () => {
    try {
      // Two reads, in parallel. The profit route is a separate endpoint on
      // purpose (see its doc comment) and it answers a different question, so
      // it is fetched beside the costing rather than folded into it.
      const [costing, profit] = await Promise.all([
        api<Costing>(`/api/jobs/${id}/costing`),
        api<Profit>(`/api/jobs/${id}/profit`),
      ]);
      setC(costing);
      setP(profit);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.push("/login");
      } else setError("Couldn't load the money view.");
    }
  }, [id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveEtc() {
    setBusy(true);
    try {
      await api(`/api/jobs/${id}/costing`, {
        method: "POST",
        json: { etcCents: Math.round(Number(etc) * 100) },
      });
      setEtc("");
      await load();
    } catch {
      setError("Couldn't save the estimate.");
    } finally {
      setBusy(false);
    }
  }

  async function addPo() {
    setBusy(true);
    try {
      await api(`/api/jobs/${id}/pos`, {
        method: "POST",
        json: {
          kind: poKind,
          vendorName: poVendor,
          amountCents: Math.round(Number(poAmount) * 100),
        },
      });
      setPoVendor("");
      setPoAmount("");
      await load();
    } catch {
      setError("Couldn't add that commitment.");
    } finally {
      setBusy(false);
    }
  }

  async function poStatus(poId: string, status: "received" | "canceled") {
    setBusy(true);
    try {
      await api(`/api/pos/${poId}/status`, { method: "POST", json: { status } });
      await load();
    } finally {
      setBusy(false);
    }
  }

  // Inside AppShell — see the sibling job screen. Same bug, same fix.
  if (!c) {
    return (
      <AppShell title="Job money">
        {showSkeleton && <PageSkeleton kind="stats" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  const pct = Math.round(c.wip.pctCompleteBps / 100);
  const overUnder =
    c.wip.underbilledCents > 0
      ? { label: `You can bill ${dollars(c.wip.underbilledCents)} more`, color: "var(--brand)" }
      : c.wip.overbilledCents > 0
        ? { label: `Billed ${dollars(c.wip.overbilledCents)} ahead of the work`, color: "var(--warn-line)" }
        : { label: "Billing matches the work — on track", color: "var(--muted)" };

  return (
    <AppShell title="Job money">
      <div className="card">
        <div className="row" style={{ marginBottom: 6 }}>
          <strong className="grow">Work done: {pct}%</strong>
          <span className="muted">
            earned {dollars(c.wip.earnedRevenueCents)} of {dollars(c.contractCents)}
          </span>
        </div>
        <Bar pctBps={c.wip.pctCompleteBps} />
        <p style={{ color: overUnder.color, fontWeight: 600, margin: "10px 0 4px" }}>
          {overUnder.label}
        </p>
        <p className="muted" style={{ margin: 0 }}>{c.explain.wip}</p>
        {c.wip.flags.lossJob && (
          <div className="banner" style={{ marginTop: 10 }}>
            <strong>Heads up:</strong> this job is expected to COST more than the
            contract pays. Time to talk change order or cut costs.
          </div>
        )}
      </div>

      {p && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>What this job has made you</h2>
          <div className="row">
            <div className="grow">
              <div className="muted">Billed</div>
              <div className="big">{dollars(p.profit.billedCents)}</div>
            </div>
            <div className="grow">
              <div className="muted">Spent</div>
              <div className="big">{dollars(p.profit.totalCostsCents)}</div>
            </div>
            <div className="grow">
              <div className="muted">Profit so far</div>
              <div
                className="big"
                style={{ color: p.profit.flags.underwater ? "var(--danger)" : "var(--brand)" }}
              >
                {dollars(p.profit.billedProfitCents)}
              </div>
            </div>
            <div className="grow">
              <div className="muted">Profit on cash in the bank</div>
              {p.profit.flags.noCollectionYet ? (
                // NOT the arithmetic answer (cost with a minus sign). Nobody
                // has paid yet, and rendering that as a big red loss next to a
                // healthy profit tells an owner their good job is underwater.
                <div className="big muted" title="Nothing has been paid on this job yet">
                  &mdash;
                </div>
              ) : (
                <div className="big">{dollars(p.profit.collectedProfitCents)}</div>
              )}
            </div>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>{p.explain}</p>

          {p.unpostedLabor && (
            <div className="banner" style={{ marginTop: 10 }}>
              <strong>Not final yet:</strong> {dollars(p.unpostedLabor.totalCents)} of
              that spending is hours from {p.unpostedLabor.workerCount}{" "}
              {p.unpostedLabor.workerCount === 1 ? "person" : "people"} that nobody
              has posted. Close the week to settle it.
            </div>
          )}

          {/*
            The OTHER gross profit, shown here deliberately and labelled for
            what it is. Both numbers are correct answers to different
            questions; the failure mode is a shop seeing two different "gross
            profits" on two screens and concluding the software cannot add up.
            Naming the driver — "your estimate to finish" — is what makes the
            difference legible rather than suspicious.
          */}
          <details style={{ marginTop: 12 }}>
            <summary className="muted" style={{ cursor: "pointer" }}>
              Why is this different from the {pct}% number above?
            </summary>
            <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
              The number up top is an <strong>accounting</strong> figure:{" "}
              {dollars(p.wip.grossProfitCents)} of profit earned on the share of
              the work you&apos;ve finished. It moves when you change your
              estimate of what&apos;s left to spend. The{" "}
              {dollars(p.profit.billedProfitCents)} here is made only of things
              that actually happened — invoices you sent and money you spent —
              so nobody can move it by re-estimating the job.
            </p>
          </details>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Spending vs budget</h2>
        <div className="row">
          <div className="grow"><div className="muted">Budget</div><div className="big">{dollars(c.budgetCents)}</div></div>
          <div className="grow"><div className="muted">Spent</div><div className="big">{dollars(c.costsCents)}</div></div>
          <div className="grow"><div className="muted">Promised (POs/subs)</div><div className="big">{dollars(c.committed.committedCents)}</div></div>
        </div>
        {c.budgetCents > 0 && (
          <div style={{ marginTop: 8 }}>
            <Bar
              pctBps={Math.min(10000, Math.round(((c.costsCents + c.committed.committedCents) / c.budgetCents) * 10000))}
              warn={c.committed.overCommitted}
            />
          </div>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>{c.explain.committed}</p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Cost to finish (your call)</h2>
        <p className="muted">
          What will it still cost to finish this job? Only you know this — it
          drives the &quot;work done&quot; math above.
          {c.wip.flags.staleEtc && " Your last estimate is getting old — worth a fresh look."}
          {c.etcCents !== null && ` Current: ${dollars(c.etcCents)}.`}
        </p>
        <div className="row">
          <div className="grow">
            <input inputMode="decimal" value={etc} onChange={(e) => setEtc(e.target.value)} placeholder="e.g. 4000" aria-label="Cost to finish, dollars" />
          </div>
          <button onClick={saveEtc} disabled={busy || etc === ""}>Save</button>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Open orders & sub commitments</h2>
        {c.purchaseOrders.length === 0 && (
          <p className="muted">Nothing promised yet. Add POs and sub contracts so the budget can&apos;t surprise you.</p>
        )}
        {c.purchaseOrders.map((po) => (
          <div key={po.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
            <div className="grow">
              <strong>{po.vendorName}</strong> <span className="pill">{po.kind === "sub" ? "sub" : "PO"}</span>{" "}
              <span className="pill">{po.status}</span>
              <div className="muted">{dollars(po.amountCents)}{po.description ? ` · ${po.description}` : ""}</div>
            </div>
            {po.status === "open" && (
              <>
                <button className="secondary" disabled={busy} onClick={() => void poStatus(po.id, "received")}>Received</button>
                <button className="secondary" disabled={busy} onClick={() => void poStatus(po.id, "canceled")}>Cancel</button>
              </>
            )}
          </div>
        ))}
        <div className="row" style={{ marginTop: 10 }}>
          <div className="grow">
            <label htmlFor="pov">Vendor / sub</label>
            <input id="pov" value={poVendor} onChange={(e) => setPoVendor(e.target.value)} placeholder="SRS Distribution" />
          </div>
          <div>
            <label htmlFor="pok">Type</label>
            <select id="pok" value={poKind} onChange={(e) => setPoKind(e.target.value)}>
              <option value="po">Material PO</option>
              <option value="sub">Sub contract</option>
            </select>
          </div>
          <div>
            <label htmlFor="poa">Amount ($)</label>
            <input id="poa" inputMode="decimal" value={poAmount} onChange={(e) => setPoAmount(e.target.value)} style={{ width: 110 }} />
          </div>
          <div style={{ alignSelf: "flex-end" }}>
            <button onClick={addPo} disabled={busy || !poVendor || !poAmount}>Add</button>
          </div>
        </div>
      </div>

      {c.costsByCode.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Where the money went</h2>
          {c.costsByCode.map((row) => (
            <div key={`${row.costCode}-${row.kind}`} className="row" style={{ padding: "4px 0" }}>
              <span className="grow">{row.costCode} · {row.kind}</span>
              <strong>{dollars(row.amountCents)}</strong>
            </div>
          ))}
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
