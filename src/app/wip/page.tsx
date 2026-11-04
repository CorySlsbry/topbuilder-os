"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Row {
  jobId: string;
  jobNo: number;
  name: string;
  status: string;
  contractCents: number;
  costsCents: number;
  billedCents: number;
  wip: {
    pctCompleteBps: number;
    earnedRevenueCents: number;
    underbilledCents: number;
    overbilledCents: number;
  };
}
interface Report {
  rows: Row[];
  totals: {
    underbilledCents: number;
    overbilledCents: number;
    contractCents: number;
    earnedCents: number;
    billedCents: number;
  };
  /**
   * The totals row in plain English, composed SERVER-side.
   *
   * It replaces a sentence that used to be hardcoded in this file. Same rule
   * as every other money figure here: the words come from the same module as
   * the numbers, so a screen and an API answer can never drift into saying
   * different things about the same totals.
   */
  explain: string;
}

export default function WipPage() {
  const router = useRouter();
  const [r, setR] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(r !== null);

  const load = useCallback(async () => {
    try {
      setR(await api<Report>("/api/wip"));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.push("/login");
      }
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function snapshot() {
    setBusy(true);
    try {
      const res = await api<{ snapshots: number }>("/api/wip", {
        method: "POST",
        json: { asOf: new Date().toISOString().slice(0, 10) },
      });
      setNote(`Saved a locked snapshot of ${res.snapshots} job${res.snapshots === 1 ? "" : "s"} — your CPA can rely on it.`);
    } catch {
      setNote("Snapshot didn't save (maybe one already exists for today).");
    } finally {
      setBusy(false);
    }
  }

  // Inside AppShell, deliberately. This used to early-return into
  // `main.shell`, which DROPPED the sidebar and topbar entirely and then
  // snapped them back when the data landed. React keeps <AppShell> mounted
  // across both branches because it sits at the same root position, so
  // /api/me does not re-fire and nothing flickers.
  if (!r) {
    return (
      <AppShell title="Work in progress">
        {showSkeleton && <PageSkeleton kind="stats" />}
        {note && <p className="muted">{note}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Work in progress">
      <div className="row">
        <div className="grow" />
        <button className="secondary" onClick={snapshot} disabled={busy}>
          Save today&apos;s snapshot
        </button>
      </div>

      <div className="card">
        <div className="row">
          <div className="grow">
            <div className="muted">You can still bill (underbilled)</div>
            <div className="big">{dollars(r.totals.underbilledCents)}</div>
          </div>
          <div className="grow">
            <div className="muted">Billed ahead of work (overbilled)</div>
            <div className="big">{dollars(r.totals.overbilledCents)}</div>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>{r.explain}</p>
        <p className="muted" style={{ marginBottom: 0, marginTop: 6 }}>
          These two never cancel each other out — one is money you&apos;re owed
          for finished work, the other is work you still owe customers.
        </p>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {r.rows.map((row) => {
          const pct = Math.round(row.wip.pctCompleteBps / 100);
          return (
            <Link key={row.jobId} href={`/jobs/${row.jobId}/money`} className="list-item">
              <div className="row">
                <strong className="grow">#{row.jobNo} · {row.name}</strong>
                <span className="pill">{pct}% done</span>
                {row.wip.underbilledCents > 0 && (
                  <span className="pill" style={{ background: "#dcefe4" }}>
                    bill {dollars(row.wip.underbilledCents)}
                  </span>
                )}
                {row.wip.overbilledCents > 0 && (
                  <span className="pill" style={{ background: "var(--warn-bg)" }}>
                    ahead {dollars(row.wip.overbilledCents)}
                  </span>
                )}
              </div>
              <div className="muted">
                earned {dollars(row.wip.earnedRevenueCents)} · billed {dollars(row.billedCents)} · spent {dollars(row.costsCents)}
              </div>
            </Link>
          );
        })}
      </div>

      {note && <p className="muted">{note}</p>}
    </AppShell>
  );
}
