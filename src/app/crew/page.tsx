"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Worker {
  id: string;
  name: string;
  trade: string;
  wcClassCode: string;
  baseHourlyCents: number;
}
interface WcClass {
  classCode: string;
  description: string;
  ratePer100Cents: number;
}
interface JobRow {
  id: string;
  jobNo: number;
  name: string;
}
interface Week {
  workerId: string;
  workerName: string;
  weekStart: string;
  entryCount: number;
  totalHoursX100: number;
  otHoursX100: number;
  wagesCents: number;
  burdenCents: number;
  totalCents: number;
  jobNos: number[];
}

const hrs = (x: number) => (x / 100).toFixed(x % 100 === 0 ? 0 : 2);

export default function CrewPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [roster, setRoster] = useState<{ id: string; name: string }[]>([]);
  const [hrAccess, setHrAccess] = useState(false);
  const [wcClasses, setWcClasses] = useState<WcClass[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  // forms
  const [wcCode, setWcCode] = useState("5551");
  const [wcDesc, setWcDesc] = useState("Roofing");
  const [wcRate, setWcRate] = useState("18.50");
  const [wName, setWName] = useState("");
  const [wRate, setWRate] = useState("28.00");
  const [wClass, setWClass] = useState("");
  const [tWorker, setTWorker] = useState("");
  const [tJob, setTJob] = useState("");
  const [tDate, setTDate] = useState(new Date().toISOString().slice(0, 10));
  const [tHours, setTHours] = useState("8");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    // Roster + jobs are for everyone (time logging). Pay rates and the
    // burdened-week money live behind the HR wall — if the server says 403,
    // those sections simply don't exist for this person.
    try {
      const [r, j] = await Promise.all([
        api<{ roster: { id: string; name: string }[] }>("/api/workforce/roster"),
        api<{ jobs: JobRow[] }>("/api/jobs"),
      ]);
      setRoster(r.roster);
      setJobs(j.jobs);
      setTWorker((c) => c || r.roster[0]?.id || "");
      setTJob((c) => c || j.jobs[0]?.id || "");
        setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push("/login");
      else setError("Couldn't load the crew screen.");
      return;
    }
    try {
      const [w, t] = await Promise.all([
        api<{ workers: Worker[]; wcClasses: WcClass[] }>("/api/workforce/workers"),
        api<{ weeks: Week[] }>("/api/workforce/time"),
      ]);
      setWorkers(w.workers);
      setWcClasses(w.wcClasses);
      setWeeks(t.weeks);
      setHrAccess(true);
      setWClass((c) => c || w.wcClasses[0]?.classCode || "");
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setHrAccess(false);
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
          ? "The Timekeeper is off — flip it to 'Ask first' under Helpers."
          : "That didn't work — check the fields and try again.",
      );
    } finally {
      setBusy(false);
      await load();
    }
  }

  const cents = (s: string) => Math.round(Number(s.replace(/[$,]/g, "")) * 100);

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Crew & time">
        {showSkeleton && <PageSkeleton kind="table" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Crew & time">
      {!hrAccess && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            You can log hours below. Pay rates and payroll totals live behind
            the &quot;People &amp; pay&quot; wall — ask the owner if you need them.
          </p>
        </div>
      )}
      {hrAccess && (<>
      <h2>Hours waiting to hit the books ({weeks.length} week{weeks.length === 1 ? "" : "s"})</h2>
      <div className="card">
        {weeks.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No pending time. Log hours below — each finished week becomes one
            labor posting at the TRUE cost (wages + taxes + workers&apos; comp
            + benefits), split for overtime automatically.
          </p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Week of</th>
                  <th>Hours</th>
                  <th>OT</th>
                  <th>Wages</th>
                  <th>Burden</th>
                  <th>True cost</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => (
                  <tr key={`${w.workerId}-${w.weekStart}`}>
                    <td>{w.workerName}</td>
                    <td>{w.weekStart} (job{w.jobNos.length === 1 ? "" : "s"} #{w.jobNos.join(", #")})</td>
                    <td>{hrs(w.totalHoursX100)}</td>
                    <td>{w.otHoursX100 > 0 ? hrs(w.otHoursX100) : "—"}</td>
                    <td>{dollars(w.wagesCents)}</td>
                    <td>{dollars(w.burdenCents)}</td>
                    <td><strong>{dollars(w.totalCents)}</strong></td>
                    <td>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(
                            () =>
                              api("/api/workforce/post-week", {
                                method: "POST",
                                json: { workerId: w.workerId, weekStart: w.weekStart },
                              }),
                            "Posted — the jobs now carry the true labor cost.",
                          )
                        }
                      >
                        Post week
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" style={{ marginBottom: 0 }}>
              Burden is the part of labor cost that isn&apos;t the paycheck —
              employer taxes, workers&apos; comp, benefits. Jobs that ignore it
              look more profitable than they are.{" "}
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const r = await api<{ proposed: number }>("/api/agents/workforce/run", {
                      method: "POST",
                      json: {},
                    });
                    setNote(
                      r.proposed > 0
                        ? `The Timekeeper wrote ${r.proposed} card${r.proposed === 1 ? "" : "s"} — approve under Helpers.`
                        : "Nothing to propose — finished weeks are already queued or posted.",
                    );
                  })
                }
              >
                🤝 Ask the Timekeeper
              </button>
            </p>
          </>
        )}
      </div>

      </>)}

      <h2>Log time</h2>
      <div className="card">
        <div className="row">
          <div>
            <label htmlFor="tw">Worker</label>
            <select id="tw" value={tWorker} onChange={(e) => setTWorker(e.target.value)}>
              {roster.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="tj">Job</label>
            <select id="tj" value={tJob} onChange={(e) => setTJob(e.target.value)}>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>#{j.jobNo} {j.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="td">Day</label>
            <input id="td" type="date" value={tDate} onChange={(e) => setTDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor="th">Hours</label>
            <input id="th" value={tHours} onChange={(e) => setTHours(e.target.value)} style={{ width: 80 }} />
          </div>
          <button
            style={{ alignSelf: "flex-end" }}
            disabled={busy || !tWorker || !tJob || !Number(tHours)}
            onClick={() =>
              void act(
                () =>
                  api("/api/workforce/time", {
                    method: "POST",
                    json: {
                      workerId: tWorker,
                      jobId: tJob,
                      workDate: tDate,
                      hoursX100: Math.round(Number(tHours) * 100),
                    },
                  }),
                "Logged.",
              )
            }
          >
            Log hours
          </button>
        </div>
      </div>

      {hrAccess && (<>
      <h2>Workers</h2>
      <div className="card">
        <div className="row">
          <input value={wName} onChange={(e) => setWName(e.target.value)} placeholder="Miguel R." aria-label="Worker name" />
          <div>
            <label htmlFor="wr">$/hour</label>
            <input id="wr" value={wRate} onChange={(e) => setWRate(e.target.value)} style={{ width: 90 }} />
          </div>
          <div>
            <label htmlFor="wc">WC class</label>
            <select id="wc" value={wClass} onChange={(e) => setWClass(e.target.value)}>
              {wcClasses.map((c) => (
                <option key={c.classCode} value={c.classCode}>
                  {c.classCode} — {c.description}
                </option>
              ))}
            </select>
          </div>
          <button
            style={{ alignSelf: "flex-end" }}
            disabled={busy || !wName.trim() || !wClass || !Number(wRate)}
            onClick={() =>
              void act(
                () =>
                  api("/api/workforce/workers", {
                    method: "POST",
                    json: {
                      type: "worker",
                      name: wName.trim(),
                      wcClassCode: wClass,
                      baseHourlyCents: cents(wRate),
                    },
                  }),
                "Worker added.",
              ).then(() => setWName(""))
            }
          >
            Add worker
          </button>
        </div>
        {workers.length > 0 && (
          <p className="muted">
            {workers.map((w) => `${w.name} (${dollars(w.baseHourlyCents)}/h, WC ${w.wcClassCode})`).join(" · ")}
          </p>
        )}
        <div className="row">
          <input value={wcCode} onChange={(e) => setWcCode(e.target.value)} style={{ width: 90 }} aria-label="WC class code" />
          <input value={wcDesc} onChange={(e) => setWcDesc(e.target.value)} placeholder="Roofing" aria-label="WC description" />
          <div>
            <label htmlFor="wcr">$ per $100 wages</label>
            <input id="wcr" value={wcRate} onChange={(e) => setWcRate(e.target.value)} style={{ width: 100 }} />
          </div>
          <button
            className="secondary"
            style={{ alignSelf: "flex-end" }}
            disabled={busy || !wcCode.trim() || !Number(wcRate)}
            onClick={() =>
              void act(
                () =>
                  api("/api/workforce/workers", {
                    method: "POST",
                    json: {
                      type: "wc-class",
                      classCode: wcCode.trim(),
                      description: wcDesc.trim(),
                      ratePer100Cents: cents(wcRate),
                    },
                  }),
                "Workers' comp class saved.",
              )
            }
          >
            Save WC class
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Workers&apos; comp rates come from your policy (e.g. roofing class
          5551 might be $18.50 per $100 of wages). Set them once — every hour
          logged carries the right burden automatically.
        </p>
      </div>

      </>)}

      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
