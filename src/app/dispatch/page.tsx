"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, newIdempotencyKey } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Appt {
  id: string;
  jobId: string;
  jobNo: number;
  jobName: string;
  startsAt: string;
  endsAt: string;
  status: string;
  workerId: string | null;
  workerName: string | null;
}
interface Board {
  weekStart: string;
  days: string[];
  workers: { id: string; name: string }[];
  appointments: Appt[];
}
interface JobRow {
  id: string;
  jobNo: number;
  name: string;
}

function mondayOf(d: Date): string {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay();
  x.setUTCDate(x.getUTCDate() - (day === 0 ? 6 : day - 1));
  return x.toISOString().slice(0, 10);
}
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function DispatchPage() {
  const router = useRouter();
  const [weekStart, setWeekStart] = useState(mondayOf(new Date()));
  const [board, setBoard] = useState<Board | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  // schedule form
  const [sJob, setSJob] = useState("");
  const [sDate, setSDate] = useState(new Date().toISOString().slice(0, 10));
  const [sTime, setSTime] = useState("08:00");
  const [sHours, setSHours] = useState("4");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(board !== null);

  const load = useCallback(async () => {
    try {
      const [b, j] = await Promise.all([
        api<Board>(`/api/dispatch?weekStart=${weekStart}`),
        api<{ jobs: JobRow[] }>("/api/jobs"),
      ]);
      setBoard(b);
      setJobs(j.jobs);
      setSJob((c) => c || j.jobs[0]?.id || "");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load the board.");
    }
  }, [router, weekStart]);

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
          ? "The Dispatcher is off — turn it on under Helpers ('Auto' assigns by itself)."
          : "That didn't work — try again.",
      );
    } finally {
      setBusy(false);
      await load();
    }
  }

  function shiftWeek(days: number) {
    const d = new Date(`${weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    setWeekStart(d.toISOString().slice(0, 10));
  }

  const time = (iso: string) => iso.slice(11, 16);
  const apptsFor = (day: string, workerId: string | null) =>
    (board?.appointments ?? []).filter(
      (a) => a.startsAt.slice(0, 10) === day && a.workerId === workerId,
    );

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!board) {
    return (
      <AppShell title="Dispatch">
        {showSkeleton && <PageSkeleton kind="table" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Dispatch board">
      <div className="card">
        <div className="row">
          <button className="secondary" onClick={() => shiftWeek(-7)} disabled={busy}>← Last week</button>
          <strong style={{ alignSelf: "center" }}>Week of {board?.weekStart ?? weekStart}</strong>
          <button className="secondary" onClick={() => shiftWeek(7)} disabled={busy}>Next week →</button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await api<{ proposed: number; executed: number }>(
                  "/api/agents/dispatch/run",
                  { method: "POST", json: {} },
                );
                setNote(
                  r.executed > 0
                    ? `The Dispatcher assigned ${r.executed} appointment${r.executed === 1 ? "" : "s"} (Auto mode) — every assignment is undoable under Helpers.`
                    : r.proposed > 0
                      ? `The Dispatcher proposed ${r.proposed} assignment${r.proposed === 1 ? "" : "s"} — approve under Helpers.`
                      : "Nothing unassigned in the next two weeks.",
                );
              })
            }
          >
            🤝 Ask the Dispatcher
          </button>
        </div>
        {board && (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th style={{ minWidth: 110 }}>Who</th>
                  {board.days.map((d, i) => {
                    const cap = Math.max(1, board.workers.length) * 2;
                    const booked = board.appointments.filter(
                      (a) => a.startsAt.slice(0, 10) === d && a.status === "scheduled",
                    ).length;
                    const full = booked >= cap;
                    return (
                      <th key={d} style={{ minWidth: 120 }}>
                        {DOW[i]} {d.slice(5)}
                        <span
                          className="pill"
                          style={{
                            display: "block",
                            marginTop: 3,
                            textTransform: "none",
                            letterSpacing: 0,
                            background: full ? "var(--warn-bg)" : undefined,
                          }}
                        >
                          {booked}/{cap} booked
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {[{ id: null as string | null, name: "🕳 Unassigned" }, ...board.workers.map((w) => ({ id: w.id as string | null, name: w.name }))].map((row) => (
                  <tr key={row.id ?? "none"}>
                    <td><strong>{row.name}</strong></td>
                    {board.days.map((d) => (
                      <td key={d}>
                        {apptsFor(d, row.id).map((a) => (
                          <div key={a.id} className="pill" style={{ display: "block", marginBottom: 4, opacity: a.status === "scheduled" ? 1 : 0.5 }}>
                            #{a.jobNo} {a.jobName.slice(0, 18)} · {time(a.startsAt)}
                            {a.status === "scheduled" && (
                              <select
                                aria-label={`Assign job ${a.jobNo}`}
                                value={a.workerId ?? ""}
                                disabled={busy}
                                style={{ display: "block", width: "100%", marginTop: 2 }}
                                onChange={(e) =>
                                  void act(() =>
                                    api("/api/dispatch/assign", {
                                      method: "POST",
                                      json: { appointmentId: a.id, workerId: e.target.value || null },
                                    }),
                                  )
                                }
                              >
                                <option value="">— unassigned —</option>
                                {board.workers.map((w) => (
                                  <option key={w.id} value={w.id}>{w.name}</option>
                                ))}
                              </select>
                            )}
                            {/* The most-loved text in the trades, one tap.
                                Keyed server-side: a nervous double-tap in the
                                truck can't text the customer twice. */}
                            {a.status === "scheduled" && a.workerId && (
                              <button
                                className="secondary"
                                style={{ display: "block", width: "100%", marginTop: 3, minHeight: 30, padding: "2px 8px", fontSize: "0.78rem" }}
                                disabled={busy}
                                onClick={() =>
                                  void act(
                                    () =>
                                      api("/api/dispatch/on-my-way", {
                                        method: "POST",
                                        idempotencyKey: newIdempotencyKey(),
                                        json: { appointmentId: a.id },
                                      }),
                                    "Customer texted: your tech is on the way. (Falls back to email until your shop number is live.)",
                                  )
                                }
                              >
                                🛻 On my way
                              </button>
                            )}
                          </div>
                        ))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <h2>Schedule an appointment</h2>
      <div className="card">
        <div className="row">
          <div className="grow">
            <label htmlFor="sj">Job</label>
            <select id="sj" value={sJob} onChange={(e) => setSJob(e.target.value)}>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>#{j.jobNo} {j.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="sd">Day</label>
            <input id="sd" type="date" value={sDate} onChange={(e) => setSDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor="st">Start</label>
            <input id="st" type="time" value={sTime} onChange={(e) => setSTime(e.target.value)} />
          </div>
          <div>
            <label htmlFor="sh">Hours</label>
            <input id="sh" value={sHours} onChange={(e) => setSHours(e.target.value)} style={{ width: 70 }} />
          </div>
          <button
            style={{ alignSelf: "flex-end" }}
            disabled={busy || !sJob || !Number(sHours)}
            onClick={() =>
              void act(async () => {
                const starts = new Date(`${sDate}T${sTime}:00`);
                const ends = new Date(starts.getTime() + Number(sHours) * 3_600_000);
                await api("/api/dispatch", {
                  method: "POST",
                  json: { jobId: sJob, startsAt: starts.toISOString(), endsAt: ends.toISOString() },
                });
              }, "Scheduled — assign it on the board or let the Dispatcher pick.")
            }
          >
            Schedule
          </button>
        </div>
      </div>

      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
