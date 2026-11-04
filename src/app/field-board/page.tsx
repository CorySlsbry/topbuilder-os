"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";
import { api, ApiError } from "@/lib/client/api";
import { DecisionList } from "@/components/dash/Dash";

/**
 * The field board — a home screen for everyone who is not the owner.
 *
 * Until this existed, `/dashboard` was the only dashboard and it sits behind
 * the `financials` wall, so a tech, a dispatcher or the office person logged in
 * to a job list and nothing else. This is not that screen with the money hidden:
 * the route it reads returns different data, and none of it can be a dollar
 * amount. See the note in /api/dashboard/field.
 *
 * The order on screen is the argument. What needs doing, then who is going
 * where. Counts last, because a number nobody acts on is decoration.
 */

interface Task {
  text: string;
  href: string;
  urgent: boolean;
}
interface Appt {
  appointmentId: string;
  jobId: string;
  jobNo: number;
  jobName: string;
  customerName: string;
  startsAt: string;
  workerName: string | null;
  status: string;
}
interface Payload {
  asOf: string;
  tasks: Task[];
  nothingToDo: string;
  today: Appt[];
  counts: { today: number; activeJobs: number; waiting: number };
}

/** Local clock time. The board is read by someone standing in the driveway. */
function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "--"
    : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function FieldBoardPage() {
  const router = useRouter();
  const [d, setD] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const showSkeleton = useFirstLoad(d !== null);

  const load = useCallback(async () => {
    try {
      setD(await api<Payload>("/api/dashboard/field"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push("/login");
      else if (e instanceof ApiError && e.status === 403) {
        // 403 here means no `field` wall — a real answer, not a login problem.
        // Sending them to /login would loop them through a working sign-in.
        setError("Your account doesn't have access to the field board. Ask your owner to add you to Field & jobs.");
      } else setError("Couldn't load the board.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!d) {
    return (
      <AppShell title="Today">
        {showSkeleton && <PageSkeleton kind="list" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Today">
      {/* Same component the owner's dashboard leads with, so the two screens
          teach the same habit: the first thing on the page is a sentence you
          can act on, not a number you still have to interpret. */}
      <DecisionList
        title="NEEDS DOING"
        decisions={d.tasks}
        emptyText={d.nothingToDo}
        urgentLabel="waiting on us"
      />

      <div className="card">
        <div className="navgroup" style={{ padding: 0, marginBottom: 8 }}>
          ON THE BOARD TODAY
        </div>
        {d.today.length === 0 ? (
          <p style={{ margin: 0 }}>Nothing scheduled today.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.35rem" }}>
            {d.today.map((a) => (
              <li key={a.appointmentId} style={{ marginBottom: 6 }}>
                <strong>{clock(a.startsAt)}</strong>{" "}
                <Link href={`/jobs/${a.jobId}`}>
                  #{a.jobNo} {a.jobName}
                </Link>{" "}
                <span className="muted">
                  {a.customerName}
                  {/* Named, not blank. "unassigned" is the single most useful
                      word on a dispatcher's screen and an empty space says
                      nothing. */}
                  {a.workerName ? ` · ${a.workerName}` : " · unassigned"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <div className="navgroup" style={{ padding: 0, marginBottom: 8 }}>
          WHERE THINGS STAND
        </div>
        <ul style={{ margin: 0, paddingLeft: "1.35rem" }}>
          <li style={{ marginBottom: 6 }}>
            <Link href="/dispatch">{d.counts.today} on the board today</Link>
          </li>
          <li style={{ marginBottom: 6 }}>
            <Link href="/jobs">{d.counts.activeJobs} jobs running</Link>
          </li>
          <li style={{ marginBottom: 6 }}>
            <Link href="/intake">{d.counts.waiting} waiting to be booked</Link>
          </li>
        </ul>
      </div>
    </AppShell>
  );
}
