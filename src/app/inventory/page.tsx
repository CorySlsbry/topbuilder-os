"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Item {
  id: string;
  name: string;
  unit: string;
  qtyOnHandX100: number;
  avgUnitCostCents: number;
  reorderPointX100: number;
  reorderQtyX100: number;
  preferredVendor: string;
  low: boolean;
}
interface JobRow {
  id: string;
  jobNo: number;
  name: string;
}

const qty = (x: number) => (x / 100).toFixed(x % 100 === 0 ? 0 : 2);

export default function InventoryPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  // new item
  const [nName, setNName] = useState("");
  const [nUnit, setNUnit] = useState("bundle");
  const [nPoint, setNPoint] = useState("");
  const [nQty, setNQty] = useState("");
  const [nVendor, setNVendor] = useState("");
  // move form
  const [mItem, setMItem] = useState("");
  const [mQty, setMQty] = useState("");
  const [mCost, setMCost] = useState("");
  const [mVendor, setMVendor] = useState("");
  const [mJob, setMJob] = useState("");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      const [i, j] = await Promise.all([
        api<{ items: Item[] }>("/api/inventory/items"),
        api<{ jobs: JobRow[] }>("/api/jobs"),
      ]);
      setItems(i.items);
      setJobs(j.jobs);
      setMItem((c) => c || i.items[0]?.id || "");
      setMJob((c) => c || j.jobs[0]?.id || "");
        setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load inventory.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await fn();
      if (ok) setNote(ok);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "agent_off"
          ? "The Restocker is off — flip it to 'Ask first' under Helpers."
          : e instanceof ApiError && e.code === "not_enough_on_hand"
            ? "Not enough on the shelf for that."
            : "That didn't work — check the fields and try again.",
      );
    } finally {
      setBusy(false);
      await load();
    }
  }

  const cents = (s: string) => Math.round(Number(s.replace(/[$,]/g, "")) * 100);
  const x100 = (s: string) => Math.round(Number(s) * 100);
  const today = new Date().toISOString().slice(0, 10);

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Stock">
        {showSkeleton && <PageSkeleton kind="table" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Materials on hand">
      <div className="card">
        {items.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Track the materials you keep on the truck or in the shop. Receiving
            stock books it as an asset; putting it on a job moves the cost to
            that job at your true average price.
          </p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>On hand</th>
                  <th>Avg cost</th>
                  <th>Value</th>
                  <th>Reorder at</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}</td>
                    <td>{qty(i.qtyOnHandX100)} {i.unit}</td>
                    <td>{dollars(i.avgUnitCostCents)}</td>
                    <td>{dollars(Math.round((i.qtyOnHandX100 * i.avgUnitCostCents) / 100))}</td>
                    <td>{i.reorderPointX100 > 0 ? `${qty(i.reorderPointX100)} ${i.unit}` : "—"}</td>
                    <td>{i.low && <span className="pill" style={{ background: "var(--warn-bg)" }}>low</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" style={{ marginBottom: 0 }}>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const r = await api<{ proposed: number }>("/api/agents/inventory/run", { method: "POST", json: {} });
                    setNote(
                      r.proposed > 0
                        ? `The Restocker drafted ${r.proposed} reorder${r.proposed === 1 ? "" : "s"} — approve under Helpers.`
                        : "Nothing is low (or reorders are already drafted).",
                    );
                  })
                }
              >
                🤝 Ask the Restocker
              </button>{" "}
              It watches your reorder points and drafts the PO — you approve
              before anything is ordered.
            </p>
          </>
        )}
      </div>

      <h2>Receive / use / count</h2>
      <div className="card">
        <div className="row">
          <div>
            <label htmlFor="mi">Item</label>
            <select id="mi" value={mItem} onChange={(e) => setMItem(e.target.value)}>
              {items.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="mq">Qty</label>
            <input id="mq" value={mQty} onChange={(e) => setMQty(e.target.value)} style={{ width: 80 }} />
          </div>
          <div>
            <label htmlFor="mc">Unit cost (receiving)</label>
            <input id="mc" value={mCost} onChange={(e) => setMCost(e.target.value)} placeholder="32.00" style={{ width: 100 }} />
          </div>
          <div className="grow">
            <label htmlFor="mv">Vendor (receiving)</label>
            <input id="mv" value={mVendor} onChange={(e) => setMVendor(e.target.value)} placeholder="ABC Supply" />
          </div>
        </div>
        <div className="row">
          <button
            disabled={busy || !mItem || !Number(mQty) || !Number(mCost) || !mVendor.trim()}
            onClick={() =>
              void act(
                () =>
                  api("/api/inventory/moves", {
                    method: "POST",
                    json: {
                      type: "receive",
                      itemId: mItem,
                      qtyX100: x100(mQty),
                      unitCostCents: cents(mCost),
                      vendorName: mVendor.trim(),
                      occurredOn: today,
                    },
                  }),
                "Received — stock is on the books and the vendor bill is in Purchasing.",
              )
            }
          >
            📦 Receive stock
          </button>
          <select value={mJob} onChange={(e) => setMJob(e.target.value)} aria-label="Job for issue">
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>#{j.jobNo} {j.name}</option>
            ))}
          </select>
          <button
            className="secondary"
            disabled={busy || !mItem || !Number(mQty) || !mJob}
            onClick={() =>
              void act(
                () =>
                  api("/api/inventory/moves", {
                    method: "POST",
                    json: { type: "issue", itemId: mItem, qtyX100: x100(mQty), jobId: mJob, occurredOn: today },
                  }),
                "Moved to the job at your average cost.",
              )
            }
          >
            🔨 Use on job
          </button>
          <button
            className="secondary"
            disabled={busy || !mItem || mQty === ""}
            onClick={() =>
              void act(
                () =>
                  api("/api/inventory/moves", {
                    method: "POST",
                    json: { type: "adjust", itemId: mItem, countedQtyX100: x100(mQty), occurredOn: today },
                  }),
                "Count corrected — the books now match the shelf.",
              )
            }
          >
            🔢 Set counted qty
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Receiving uses qty + unit cost + vendor. &quot;Use on job&quot; uses
          qty + job. &quot;Set counted qty&quot; makes the books match a
          physical count (the difference books as material cost).
        </p>
      </div>

      <h2>Add an item</h2>
      <div className="card">
        <div className="row">
          <input value={nName} onChange={(e) => setNName(e.target.value)} placeholder="Shingles, Duration Storm (bundle)" aria-label="Item name" />
          <input value={nUnit} onChange={(e) => setNUnit(e.target.value)} style={{ width: 90 }} aria-label="Unit" />
          <div>
            <label htmlFor="np">Reorder at</label>
            <input id="np" value={nPoint} onChange={(e) => setNPoint(e.target.value)} style={{ width: 90 }} placeholder="20" />
          </div>
          <div>
            <label htmlFor="nq">Reorder qty</label>
            <input id="nq" value={nQty} onChange={(e) => setNQty(e.target.value)} style={{ width: 90 }} placeholder="100" />
          </div>
          <input value={nVendor} onChange={(e) => setNVendor(e.target.value)} placeholder="Preferred vendor" aria-label="Preferred vendor" />
          <button
            style={{ alignSelf: "flex-end" }}
            disabled={busy || !nName.trim()}
            onClick={() =>
              void act(
                () =>
                  api("/api/inventory/items", {
                    method: "POST",
                    json: {
                      name: nName.trim(),
                      unit: nUnit.trim() || "ea",
                      reorderPointX100: nPoint ? x100(nPoint) : 0,
                      reorderQtyX100: nQty ? x100(nQty) : 0,
                      preferredVendor: nVendor.trim(),
                    },
                  }),
                "Item added.",
              ).then(() => setNName(""))
            }
          >
            Add item
          </button>
        </div>
      </div>

      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
