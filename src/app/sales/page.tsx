"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, centsFromInput, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

/**
 * Sales — the opportunity pipeline, from the book the shop already owns.
 *
 * ServiceTitan's grammar (stages, per-stage totals, days-in-stage) without
 * ServiceTitan's licensed data: every opportunity starts from a customer
 * already in this tenant's book. The map/pins view was built and then parked
 * on Cory's call (2026-08-14, "not useful yet") — the geocoder still runs
 * nightly so coordinates are ready the day it earns its way back.
 */

interface Opp {
  id: string;
  customerId: string;
  customerName: string;
  title: string;
  stage: string;
  valueCents: number;
  daysInStage: number;
  createdAt: string;
}

interface Customer {
  id: string;
  name: string;
}

interface Target {
  customerId: string;
  name: string;
  score: number;
  signals: { key: string; reason: string; weight: number }[];
  hiddenSignals: number;
}

const STAGES: { key: string; label: string }[] = [
  { key: "new", label: "New" },
  { key: "qualify", label: "Qualify" },
  { key: "propose", label: "Propose" },
  { key: "follow_up", label: "Follow up" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
];
const NEXT: Record<string, string[]> = {
  new: ["qualify", "lost"],
  qualify: ["propose", "lost"],
  propose: ["follow_up", "won", "lost"],
  follow_up: ["won", "lost"],
};

export default function SalesPage() {
  const router = useRouter();
  const [opps, setOpps] = useState<Opp[] | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [custId, setCustId] = useState("");
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [lostFor, setLostFor] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState("");
  const showSkeleton = useFirstLoad(opps !== null);

  const load = useCallback(async () => {
    try {
      const [o, c, t] = await Promise.all([
        api<{ opportunities: Opp[] }>("/api/sales/opportunities"),
        api<{ customers: Customer[] }>("/api/customers"),
        api<{ targets: Target[] }>("/api/sales/targets"),
      ]);
      setOpps(o.opportunities);
      setCustomers(c.customers);
      setTargets(t.targets);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load the pipeline.");
    }
  }, [router]);
  useEffect(() => { void load(); }, [load]);

  const byStage = useMemo(() => {
    const m = new Map<string, Opp[]>(STAGES.map((s) => [s.key, []]));
    (opps ?? []).forEach((o) => m.get(o.stage)?.push(o));
    return m;
  }, [opps]);

  async function create() {
    if (!custId) { setNote("Pick a customer first."); return; }
    const valueCents = value.trim() ? centsFromInput(value) : 0;
    if (valueCents === null) { setNote("That value didn't read as an amount."); return; }
    setBusy(true); setNote("");
    try {
      const name = customers.find((c) => c.id === custId)?.name ?? "customer";
      await api("/api/sales/opportunities", {
        method: "POST",
        json: { customerId: custId, title: title.trim() || `Follow-up — ${name}`, valueCents: valueCents ?? 0 },
      });
      setTitle(""); setValue("");
      setNote("Opportunity started.");
      await load();
    } catch {
      setNote("Couldn't start the opportunity — try again.");
    } finally { setBusy(false); }
  }

  async function startFromTarget(t: Target) {
    setBusy(true); setNote("");
    try {
      await api("/api/sales/opportunities", {
        method: "POST",
        json: { customerId: t.customerId, title: `Win-back — ${t.name}`, valueCents: 0 },
      });
      await load();
    } catch { setNote("Couldn't start the opportunity — try again."); }
    finally { setBusy(false); }
  }
  async function disposition(t: Target, signalKey: string, d: "dismissed" | "snoozed") {
    setBusy(true);
    try {
      await api("/api/sales/targets", {
        method: "POST",
        json: { customerId: t.customerId, signalKey, disposition: d, ...(d === "snoozed" ? { days: 90 } : {}) },
      });
      await load();
    } catch { setNote("Couldn't update that — try again."); }
    finally { setBusy(false); }
  }

  async function advance(o: Opp, stage: string) {
    if (stage === "lost") { setLostFor(o.id); setLostReason(""); return; }
    await move(o.id, stage);
  }
  async function move(id: string, stage: string, reason?: string) {
    setBusy(true);
    try {
      await api(`/api/sales/opportunities/${id}/stage`, {
        method: "POST",
        json: { stage, ...(reason ? { lostReason: reason } : {}) },
      });
      setLostFor(null);
      await load();
    } catch {
      setNote("Couldn't move it — reload and try again.");
    } finally { setBusy(false); }
  }

  if (!opps) {
    return (
      <AppShell title="Sales">
        {showSkeleton && <PageSkeleton kind="table" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  const open = opps.filter((o) => o.stage !== "won" && o.stage !== "lost");
  const openValue = open.reduce((t, o) => t + o.valueCents, 0);

  return (
    <AppShell title="Sales">
      <p className="muted" style={{ marginTop: 0 }}>
        Every deal in play, started from customers already in your book — the
        cheapest lead there is. A lost deal always records why, so next
        quarter you know what actually kills your quotes.
      </p>

      {/* the stage rail — ST's per-stage counts and totals, in plain terms */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
        {STAGES.map((s) => {
          const list = byStage.get(s.key) ?? [];
          const total = list.reduce((t, o) => t + o.valueCents, 0);
          return (
            <div key={s.key} className="card" style={{ padding: "12px 14px" }}>
              <div className="muted" style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase" }}>{s.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{list.length}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{total > 0 ? dollars(total) : "—"}</div>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <strong>{open.length} open</strong>
        <span className="muted"> worth {dollars(openValue)} if it all lands.</span>
      </div>

      {/* today's targets — the signals engine, every reason from the book */}
      {targets.length > 0 && (
        <section style={{ marginTop: 18 }}>
          <h3 style={{ margin: "0 0 4px" }}>Worth a call this week</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
            Ranked from your own records — equipment age, memberships, quotes
            that walked. Every reason names its data; nothing is guessed.
          </p>
          {targets.slice(0, 8).map((t) => (
            <div key={t.customerId} className="card" style={{ marginBottom: 8, padding: "12px 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <strong>{t.name}</strong>
                <button disabled={busy} onClick={() => void startFromTarget(t)}>Start opportunity</button>
              </div>
              {t.signals.map((sg) => (
                <div key={sg.key} style={{ display: "flex", gap: 10, alignItems: "start", justifyContent: "space-between", borderTop: "1px solid var(--line, #E2E8F0)", padding: "8px 0 2px", marginTop: 8 }}>
                  <p className="muted" style={{ margin: 0, fontSize: 13.5, maxWidth: "62ch" }}>{sg.reason}</p>
                  <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button className="secondary" style={{ minHeight: 30, padding: "2px 10px", fontSize: 12.5 }} disabled={busy}
                      onClick={() => void disposition(t, sg.key, "snoozed")}>Snooze 90d</button>
                    <button className="secondary" style={{ minHeight: 30, padding: "2px 10px", fontSize: 12.5 }} disabled={busy}
                      onClick={() => void disposition(t, sg.key, "dismissed")}>Dismiss</button>
                  </span>
                </div>
              ))}
              {t.hiddenSignals > 0 && (
                <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>{t.hiddenSignals} more signal{t.hiddenSignals === 1 ? "" : "s"} snoozed or dismissed.</p>
              )}
            </div>
          ))}
        </section>
      )}

      {/* start one */}
      <div className="card" style={{ marginTop: 14, display: "grid", gap: 8, maxWidth: 560 }}>
        <label htmlFor="np-cust" className="muted" style={{ fontSize: 12.5 }}>Start an opportunity</label>
        <select id="np-cust" value={custId} onChange={(e) => setCustId(e.target.value)}>
          <option value="">Pick a customer…</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input aria-label="Title" placeholder="What's the work? (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input aria-label="Estimated value" placeholder="Value (optional) — 4,800" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" />
        <button onClick={() => void create()} disabled={busy}>{busy ? "Saving…" : "Start opportunity"}</button>
        {note && <p className="muted" role="status" style={{ margin: 0 }}>{note}</p>}
      </div>

      {/* the pipeline itself */}
      {STAGES.filter((s) => (byStage.get(s.key) ?? []).length > 0).map((s) => (
        <section key={s.key} style={{ marginTop: 18 }}>
          <h3 style={{ margin: "0 0 8px" }}>{s.label}</h3>
          {(byStage.get(s.key) ?? []).map((o) => (
            <div key={o.id} className="card" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", marginBottom: 8, padding: "12px 16px" }}>
              <div style={{ minWidth: 220 }}>
                <strong>{o.title}</strong>
                <div className="muted" style={{ fontSize: 13 }}>
                  {o.customerName} · {o.daysInStage}d in stage{o.valueCents > 0 ? ` · ${dollars(o.valueCents)}` : ""}
                </div>
              </div>
              {lostFor === o.id ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input aria-label="Why was it lost?" placeholder="Why? (required)" value={lostReason} onChange={(e) => setLostReason(e.target.value)} />
                  <button disabled={busy || !lostReason.trim()} onClick={() => void move(o.id, "lost", lostReason.trim())}>Mark lost</button>
                  <button className="secondary" onClick={() => setLostFor(null)}>Cancel</button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(NEXT[o.stage] ?? []).map((n) => (
                    <button key={n} className={n === "won" ? "" : "secondary"} disabled={busy}
                      onClick={() => void advance(o, n)}>
                      {n === "follow_up" ? "Follow up" : n[0]!.toUpperCase() + n.slice(1)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
