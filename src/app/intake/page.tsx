"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Intake {
  id: string;
  source: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  description: string;
  preferredWindow: string;
  status: string;
  jobId: string | null;
  createdAt: string;
}
interface Slot {
  date: string;
  window: "am" | "pm";
  remaining: number;
}

export default function IntakePage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [requests, setRequests] = useState<Intake[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  // manual entry
  const [mName, setMName] = useState("");
  const [mPhone, setMPhone] = useState("");
  const [mDesc, setMDesc] = useState("");
  const [mWin, setMWin] = useState<"any" | "morning" | "afternoon">("any");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      const r = await api<{ requests: Intake[]; slots: Slot[] }>("/api/intake");
      setRequests(r.requests);
      setSlots(r.slots);
        setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load intake.");
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
          ? "The Receptionist is off — turn it on under Helpers ('Auto' books by itself)."
          : "That didn't work — try again.",
      );
    } finally {
      setBusy(false);
      await load();
    }
  }

  const fresh = requests.filter((r) => r.status === "new");
  const rest = requests.filter((r) => r.status !== "new").slice(0, 10);

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Intake">
        {showSkeleton && <PageSkeleton kind="list" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="New requests">
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Everything lands here — the website form, the phone line (when
          voice is connected), and anything you type in. The Receptionist
          books each request into a slot your crew can actually make.{" "}
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await api<{ proposed: number; executed: number; noSlots: number }>(
                  "/api/agents/booking/run",
                  { method: "POST", json: {} },
                );
                setNote(
                  r.executed > 0
                    ? `Booked ${r.executed} (Auto mode) — see Dispatch. Every booking is undoable under Helpers.`
                    : r.proposed > 0
                      ? `${r.proposed} booking${r.proposed === 1 ? "" : "s"} proposed — approve under Helpers.`
                      : r.noSlots > 0
                        ? "No open slots left in the next two weeks — add workers or clear the board."
                        : "Nothing new to book.",
                );
              })
            }
          >
            🤝 Ask the Receptionist
          </button>
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          Open slots (next 2 weeks):{" "}
          {slots.length === 0
            ? "none — the calendar is full"
            : slots
                .slice(0, 6)
                .map((s) => `${s.date.slice(5)} ${s.window === "am" ? "morning" : "afternoon"} (${s.remaining})`)
                .join(" · ")}
        </p>
      </div>

      <h2>Waiting ({fresh.length})</h2>
      {fresh.length === 0 && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>Inbox zero. New requests appear here the moment they arrive.</p>
        </div>
      )}
      {fresh.map((r) => (
        <div key={r.id} className="card">
          <div className="row">
            <div className="grow">
              <strong>{r.name}</strong> <span className="pill">{r.source}</span>{" "}
              {r.preferredWindow !== "any" && <span className="pill">prefers {r.preferredWindow}</span>}
              <div className="muted">
                {r.phone && `${r.phone} · `}
                {r.address && `${r.address} · `}
                {r.description || "no details"}
              </div>
            </div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(
                  () => api("/api/intake", { method: "POST", json: { type: "status", intakeId: r.id, status: "declined" } }),
                  "Declined.",
                )
              }
            >
              Decline
            </button>
          </div>
        </div>
      ))}

      <h2>Add one by hand</h2>
      <div className="card">
        <div className="row">
          <input value={mName} onChange={(e) => setMName(e.target.value)} placeholder="Caller name" aria-label="Name" />
          <input value={mPhone} onChange={(e) => setMPhone(e.target.value)} placeholder="Phone" aria-label="Phone" style={{ width: 140 }} />
          <input value={mDesc} onChange={(e) => setMDesc(e.target.value)} placeholder="What do they need?" aria-label="Description" className="grow" />
          <select value={mWin} onChange={(e) => setMWin(e.target.value as typeof mWin)} aria-label="Preferred time">
            <option value="any">Any time</option>
            <option value="morning">Morning</option>
            <option value="afternoon">Afternoon</option>
          </select>
          <button
            disabled={busy || !mName.trim()}
            onClick={() =>
              void act(
                () =>
                  api("/api/intake", {
                    method: "POST",
                    json: {
                      type: "manual",
                      externalId: `manual-${Date.now()}`,
                      name: mName.trim(),
                      phone: mPhone.trim() || undefined,
                      description: mDesc.trim() || undefined,
                      preferredWindow: mWin,
                    },
                  }),
                "Added to the queue.",
              ).then(() => {
                setMName("");
                setMPhone("");
                setMDesc("");
              })
            }
          >
            Add request
          </button>
        </div>
      </div>

      {rest.length > 0 && (
        <>
          <h2>Recently handled</h2>
          <div className="card">
            <p className="muted" style={{ margin: 0 }}>
              {rest.map((r) => `${r.name} (${r.status})`).join(" · ")}
            </p>
          </div>
        </>
      )}

      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
