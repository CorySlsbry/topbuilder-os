"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import CostCodeSelect, { type CostCodeOption } from "@/components/CostCodeSelect";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";
import {
  enqueue,
  flush,
  readQueue,
  type KV,
  type QueuedCost,
} from "@/lib/client/outbox";

const kv: KV = {
  get: (k) => (typeof window === "undefined" ? null : window.localStorage.getItem(k)),
  set: (k, v) => window.localStorage.setItem(k, v),
};

interface JobRow {
  id: string;
  jobNo: number;
  name: string;
}

/**
 * The field screen: built for a phone with gloves on and no signal.
 * Costs queue locally and send themselves when the connection returns.
 */
export default function FieldPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [costCodes, setCostCodes] = useState<CostCodeOption[]>([]);
  const [costCode, setCostCode] = useState("");
  const [loaded, setLoaded] = useState(false);
  // First paint only — the latch means a save never re-flashes the screen.
  const showFieldSkeleton = useFirstLoad(loaded);
  const [jobId, setJobId] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("material");
  const [memo, setMemo] = useState("");
  const [pending, setPending] = useState<QueuedCost[]>([]);
  const [note, setNote] = useState("");

  const doFlush = useCallback(async () => {
    const result = await flush(kv, async (item) => {
      try {
        await api(`/api/jobs/${item.jobId}/costs`, {
          method: "POST",
          // ⛔ REQUIRED, AND ITS ABSENCE WAS SILENTLY LOSING EVERY FIELD
          // COST. The route is idempotent({ require: true }); without a key
          // it answers 400, and `flush` treats any 4xx as permanently
          // rejected and DELETES the item from the queue. The screen said
          // "saved" and the money vanished.
          //
          // The queued item's own id is the right key: it is a UUID minted
          // once when the tech tapped save, so it is stable across every
          // retry from the roof and unique per capture — which is exactly
          // what stops a flaky connection double-posting the same receipt.
          idempotencyKey: item.id,
          json: {
            costCode: item.costCode,
            kind: item.kind,
            amountCents: item.amountCents,
            occurredOn: item.occurredOn,
            memo: item.memo,
          },
        });
        return "ok";
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401) {
          return "rejected";
        }
        return "retry";
      }
    });
    setPending(result.remaining);
    if (result.sent > 0) setNote(`Sent ${result.sent} saved cost${result.sent > 1 ? "s" : ""}.`);
  }, []);

  useEffect(() => {
    setPending(readQueue(kv));
    // Install the offline shell (PWA) and flush whenever we come back online.
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js");
    }
    const onOnline = () => void doFlush();
    window.addEventListener("online", onOnline);
    void doFlush();
    api<{ jobs: JobRow[] }>("/api/jobs")
      .finally(() => setLoaded(true))
      .then((d) => {
        setJobs(d.jobs);
        if (d.jobs[0]) setJobId((cur) => cur || d.jobs[0]!.id);
        // Cache the job list for offline job picking.
        kv.set("tb.field.jobs.v1", JSON.stringify(d.jobs));
      })
      .then(() =>
        // Cached the same way as the jobs, and for the same reason: this
        // screen is used on a roof with two bars, and a cost that cannot be
        // coded is a cost that does not get captured.
        api<{ costCodes: CostCodeOption[] }>("/api/cost-codes").then((r) => {
          setCostCodes(r.costCodes);
          setCostCode((cur) => cur || r.costCodes[0]?.code || "");
          kv.set("tb.field.costcodes.v1", JSON.stringify(r.costCodes));
        }),
      )
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          router.push("/login");
          return;
        }
        // Offline: fall back to the cached job list and cost codes.
        try {
          const cached = kv.get("tb.field.jobs.v1");
          if (cached) setJobs(JSON.parse(cached) as JobRow[]);
          const codes = kv.get("tb.field.costcodes.v1");
          if (codes) {
            const parsed = JSON.parse(codes) as CostCodeOption[];
            setCostCodes(parsed);
            setCostCode((cur) => cur || parsed[0]?.code || "");
          }
        } catch {
          /* no cache — the form still queues */
        }
      });
    return () => window.removeEventListener("online", onOnline);
  }, [doFlush, router]);

  function saveCost() {
    const job = jobs.find((j) => j.id === jobId);
    if (!job || !amount) return;
    enqueue(kv, {
      id: crypto.randomUUID(),
      jobId: job.id,
      jobName: job.name,
      costCode,
      kind: kind as QueuedCost["kind"],
      amountCents: Math.round(Number(amount) * 100),
      occurredOn: new Date().toISOString().slice(0, 10),
      memo: memo || undefined,
      queuedAt: new Date().toISOString(),
    });
    setPending(readQueue(kv));
    setAmount("");
    setMemo("");
    setNote(navigator.onLine ? "Saved — sending…" : "Saved. It'll send when you're back in signal.");
    void doFlush();
  }

  // The screen most likely to spend real time loading — a phone on a roof
  // with two bars — was the one with no loading state at all.
  if (!loaded) {
    return (
      <AppShell title="Field capture">
        {showFieldSkeleton && <PageSkeleton kind="list" />}
      </AppShell>
    );
  }

  return (
    <AppShell title="Field capture">
      {pending.length > 0 && (
        <div className="banner">
          {pending.length} saved cost{pending.length > 1 ? "s" : ""} waiting to
          send{typeof navigator !== "undefined" && !navigator.onLine ? " (no signal right now — that's fine)" : "…"}
        </div>
      )}

      <div className="card">
        <label htmlFor="fjob">Job</label>
        <select id="fjob" value={jobId} onChange={(e) => setJobId(e.target.value)}>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              #{j.jobNo} · {j.name}
            </option>
          ))}
        </select>
        <label htmlFor="famt">Amount ($)</label>
        <input id="famt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="84.20" />
        <label htmlFor="fcode">Cost code</label>
        {/* Picking a code sets the kind too — so "Subcontractor" cannot go
            in as material and quietly mis-split the job's labor report. */}
        <CostCodeSelect
          id="fcode"
          costCodes={costCodes}
          value={costCode}
          onChange={setCostCode}
          onKind={setKind}
        />
        <label htmlFor="fkind">What kind?</label>
        <select id="fkind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="material">Materials</option>
          <option value="labor">Labor</option>
          <option value="sub">Subcontractor</option>
          <option value="equipment">Equipment</option>
          <option value="other">Other</option>
        </select>
        <label htmlFor="fmemo">Note (optional)</label>
        <input id="fmemo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="supply run" />
        <div style={{ marginTop: 12 }}>
          <button onClick={saveCost} disabled={!amount || !jobId} style={{ width: "100%" }}>
            Save cost
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Works with no signal — saved costs send themselves later. Receipt
          photos need a connection (add them from the job screen).
        </p>
      </div>

      {note && <p className="muted">{note}</p>}
    </AppShell>
  );
}
