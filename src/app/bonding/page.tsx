"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

/**
 * Bonding & surety.
 *
 * An underwriter is answering one question: "if this contractor walks off a
 * job, what does it cost me?" Every panel here is instrumentation for that
 * question, in the shape they read it in.
 */

interface CipRow {
  jobId: string; jobNo: number; name: string; customerName: string;
  ownerName: string | null; contractType: string; bonded: boolean;
  bondNumber: string | null; suretyName: string | null;
  startedOn: string | null; estCompletionOn: string | null; status: string;
  contractCents: number; pendingChangeOrderCents: number;
  estTotalCostCents: number; estGrossProfitCents: number;
  estGrossMarginBps: number | null; pctCompleteBps: number;
  costsToDateCents: number; earnedRevenueCents: number;
  grossProfitEarnedCents: number; billedToDateCents: number;
  retainageHeldCents: number; underbilledCents: number; overbilledCents: number;
  remainingToBillCents: number; grossProfitRemainingCents: number;
  flags: {
    zeroEstimate: boolean; billedPastContract: boolean; staleEtc: boolean;
    lossJob: boolean; materialPendingCos: boolean;
  };
}
interface Cip {
  asOf: string;
  rows: CipRow[];
  totals: Record<string, number>;
  tieOut: {
    ledgerUnderbilledCents: number; ledgerOverbilledCents: number;
    underDeltaCents: number; overDeltaCents: number;
    tied: boolean; lastAdjustmentOn: string | null;
  };
  explain: string;
}
interface FadeRow {
  jobId: string; jobNo: number; name: string; customerName: string;
  completedOn: string | null; bonded: boolean; snapshotCount: number;
  finalContractCents: number; finalCostCents: number;
  actualGrossProfitCents: number; actualGrossMarginBps: number | null;
  estGrossProfitAtAwardCents: number | null;
  estGrossProfitAtLastSnapshotCents: number | null;
  fadeFromAwardCents: number | null; fadeFromAwardBps: number | null;
  fadeFromLastSnapshotCents: number | null;
}
interface Completed {
  from: string; to: string; rows: FadeRow[];
  summary: {
    jobsWithBaseline: number; jobsFaded: number; jobsImproved: number;
    totalFadeCents: number; weightedFadeBps: number | null; worstFadeCents: number | null;
  };
  explain: string;
}
interface BacklogRow {
  jobId: string; jobNo: number; name: string; customerName: string; status: string;
  contractCents: number; remainingRevenueCents: number;
  remainingGrossProfitCents: number; estCompletionOn: string | null; bonded: boolean;
}
interface Ratios {
  asOf: string;
  ratios: {
    workingCapitalCents: number; currentRatioBps: number | null;
    debtToEquityBps: number | null; tangibleNetWorthCents: number;
    revenueToWorkingCapitalBps: number | null; daysInAr: number | null;
    underbillingsToEquityBps: number | null;
  };
  inputs: Record<string, number>;
  classified: { code: string; name: string; suretyClass: string }[];
  unclassified: boolean;
  explain: string;
}
interface Facility {
  id: string; lender: string; kind: string; limitCents: number;
  balanceCents: number; rateBps: number | null; maturesOn: string | null;
  personallyGuaranteed: boolean; notes: string;
}
interface Payload {
  cip: Cip; completed: Completed;
  backlog: { rows: BacklogRow[]; totals: Record<string, number>; explain: string };
  ratios: Ratios; facilities: Facility[];
}

const pct = (bps: number | null) => (bps === null ? "n/a" : `${(bps / 100).toFixed(1)}%`);
const times = (bps: number | null) => (bps === null ? "n/a" : `${(bps / 10_000).toFixed(2)}×`);

export default function BondingPage() {
  const router = useRouter();
  const [d, setD] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"cip" | "fade" | "backlog" | "ratios">("cip");
  const showSkeleton = useFirstLoad(d !== null);

  const load = useCallback(async () => {
    try {
      setD(await api<Payload>("/api/bonding"));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.push("/login");
      } else setError("Couldn't load the bonding package.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function postAdjustment() {
    if (!d) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ underDeltaCents: number; overDeltaCents: number; alreadyPosted: boolean }>(
        "/api/bonding/wip-adjustment",
        { method: "POST", json: { asOf: d.cip.asOf } },
      );
      setNote(
        r.alreadyPosted
          ? "Checked — your books already matched the schedule, so nothing needed to move."
          : `Posted. Costs in excess of billings moved ${dollars(Math.abs(r.underDeltaCents))}, billings in excess moved ${dollars(Math.abs(r.overDeltaCents))}. Your balance sheet now shows the work in progress.`,
      );
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "adjustment_already_posted_for_that_date"
          ? "An adjustment is already on the books for this date. Pick a different as-of date."
          : e instanceof ApiError && e.status === 403
            ? "That needs 2-step verification — turn it on under Sign-in security."
            : "Couldn't post the adjustment.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!d) {
    return (
      <AppShell title="Bonding & surety">
        {showSkeleton && <PageSkeleton kind="table" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  const t = d.cip.totals;

  return (
    <AppShell title="Bonding & surety">
      <div className="card">
        <div className="row">
          <div className="grow">
            <p style={{ marginTop: 0 }}>
              The four schedules a surety underwriter asks for, built from your
              own general ledger. As of <strong>{d.cip.asOf}</strong>.
            </p>
          </div>
          <a
            className="pill"
            style={{ padding: "10px 14px", alignSelf: "center" }}
            href={`/api/bonding/package?to=${d.cip.asOf}`}
          >
            📦 Download the bonding package
          </a>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          One zip: contracts in progress, completed contracts with profit fade,
          backlog, the ratio panel, your bank lines, the balance sheet, the
          trial balance and the AR aging — plus a README that states the method
          and what this is not. It is not a CPA-prepared statement and it claims
          no bonding capacity; that multiple is your underwriter&apos;s call.
        </p>
      </div>

      {/* ⛔ THE TIE-OUT GOES FIRST. A schedule that does not agree with the
          ledger is one an underwriter discounts, and burying that fact three
          screens deep is how a shop finds out in the meeting. */}
      <div
        className="card"
        style={{ background: d.cip.tieOut.tied ? undefined : "var(--warn-bg)" }}
      >
        <div className="row">
          <div className="grow">
            <strong>
              {d.cip.tieOut.tied
                ? "✓ This schedule ties to your general ledger"
                : "⚠ This schedule does not tie to your general ledger yet"}
            </strong>
            <div className="muted">
              {d.cip.tieOut.tied ? (
                <>
                  Accounts 1265 and 2480 carry the same over- and
                  under-billings shown below. Last adjustment posted{" "}
                  {d.cip.tieOut.lastAdjustmentOn}.
                </>
              ) : (
                <>
                  Your books show {dollars(d.cip.tieOut.ledgerUnderbilledCents)} of
                  costs in excess of billings; this schedule says{" "}
                  {dollars(Number(t.underbilledCents))}. Posting the
                  percentage-of-completion adjustment moves the ledger to match —
                  it is the same entry your CPA makes by hand at year end.
                </>
              )}
            </div>
          </div>
          {!d.cip.tieOut.tied && (
            <button disabled={busy} onClick={() => void postAdjustment()} style={{ alignSelf: "center" }}>
              Post the adjustment
            </button>
          )}
        </div>
      </div>

      <div className="row" role="group" aria-label="Which schedule">
        {([
          ["cip", `Contracts in progress (${d.cip.rows.length})`],
          ["fade", `Completed & profit fade (${d.completed.rows.length})`],
          ["backlog", `Backlog (${d.backlog.rows.length})`],
          ["ratios", "Ratios & bank lines"],
        ] as const).map(([k, label]) => (
          <button key={k} type="button" className="chip" aria-pressed={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "cip" && (
        <>
          <div className="card">
            <div className="row">
              <div className="grow">
                <div className="muted">Contracts (incl. approved COs)</div>
                <div className="big">{dollars(Number(t.contractCents))}</div>
              </div>
              <div className="grow">
                <div className="muted">Costs in excess of billings</div>
                <div className="big">{dollars(Number(t.underbilledCents))}</div>
              </div>
              <div className="grow">
                <div className="muted">Billings in excess of costs</div>
                <div className="big">{dollars(Number(t.overbilledCents))}</div>
              </div>
              <div className="grow">
                <div className="muted">Gross profit earned</div>
                <div className="big">{dollars(Number(t.grossProfitEarnedCents))}</div>
              </div>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>{d.cip.explain}</p>
            {Number(t.pendingChangeOrderCents) > 0 && (
              <p className="muted" style={{ marginBottom: 0 }}>
                <strong>{dollars(Number(t.pendingChangeOrderCents))}</strong> of
                change orders are sent but not approved. They are listed
                separately and are <strong>not</strong> in any total above —
                booking unapproved change orders as contract value is the first
                thing an underwriter tests for.
              </p>
            )}
          </div>

          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Job</th><th>Owner / GC</th><th>Type</th>
                  <th style={{ textAlign: "right" }}>Contract</th>
                  <th style={{ textAlign: "right" }}>Pending COs</th>
                  <th style={{ textAlign: "right" }}>Est. cost</th>
                  <th style={{ textAlign: "right" }}>Est. GP</th>
                  <th style={{ textAlign: "right" }}>%</th>
                  <th style={{ textAlign: "right" }}>Costs</th>
                  <th style={{ textAlign: "right" }}>Earned</th>
                  <th style={{ textAlign: "right" }}>Billed</th>
                  <th style={{ textAlign: "right" }}>Retainage</th>
                  <th style={{ textAlign: "right" }}>Under</th>
                  <th style={{ textAlign: "right" }}>Over</th>
                  <th>Completion</th>
                </tr>
              </thead>
              <tbody>
                {d.cip.rows.map((r) => (
                  <tr key={r.jobId}>
                    <td>
                      <Link href={`/jobs/${r.jobId}`}>#{r.jobNo} {r.name}</Link>
                      {r.bonded && <span className="pill">bonded</span>}
                      {r.flags.lossJob && (
                        <span className="pill" style={{ background: "var(--warn-bg)" }}>loss</span>
                      )}
                      {r.flags.staleEtc && <span className="pill">stale estimate</span>}
                    </td>
                    <td>{r.ownerName ?? r.customerName}</td>
                    <td className="muted">{r.contractType}</td>
                    <td style={{ textAlign: "right" }}>{dollars(r.contractCents)}</td>
                    <td style={{ textAlign: "right" }} className="muted">
                      {r.pendingChangeOrderCents > 0 ? dollars(r.pendingChangeOrderCents) : "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>{dollars(r.estTotalCostCents)}</td>
                    <td style={{ textAlign: "right" }}>
                      {dollars(r.estGrossProfitCents)} <span className="muted">{pct(r.estGrossMarginBps)}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>{(r.pctCompleteBps / 100).toFixed(0)}%</td>
                    <td style={{ textAlign: "right" }}>{dollars(r.costsToDateCents)}</td>
                    <td style={{ textAlign: "right" }}>{dollars(r.earnedRevenueCents)}</td>
                    <td style={{ textAlign: "right" }}>{dollars(r.billedToDateCents)}</td>
                    <td style={{ textAlign: "right" }}>{dollars(r.retainageHeldCents)}</td>
                    <td style={{ textAlign: "right" }}>{r.underbilledCents > 0 ? dollars(r.underbilledCents) : "—"}</td>
                    <td style={{ textAlign: "right" }}>{r.overbilledCents > 0 ? dollars(r.overbilledCents) : "—"}</td>
                    <td className="muted">{r.estCompletionOn ?? "not set"}</td>
                  </tr>
                ))}
                <tr>
                  <th>TOTAL</th><th /><th />
                  <th style={{ textAlign: "right" }}>{dollars(Number(t.contractCents))}</th>
                  <th style={{ textAlign: "right" }}>{dollars(Number(t.pendingChangeOrderCents))}</th>
                  <th style={{ textAlign: "right" }}>{dollars(Number(t.estTotalCostCents))}</th>
                  <th style={{ textAlign: "right" }}>{dollars(Number(t.estGrossProfitCents))}</th>
                  <th />
                  <th style={{ textAlign: "right" }}>{dollars(Number(t.costsToDateCents))}</th>
                  <th style={{ textAlign: "right" }}>{dollars(Number(t.earnedRevenueCents))}</th>
                  <th style={{ textAlign: "right" }}>{dollars(Number(t.billedToDateCents))}</th>
                  <th style={{ textAlign: "right" }}>{dollars(Number(t.retainageHeldCents))}</th>
                  <th style={{ textAlign: "right" }}>{dollars(Number(t.underbilledCents))}</th>
                  <th style={{ textAlign: "right" }}>{dollars(Number(t.overbilledCents))}</th>
                  <th />
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "fade" && (
        <>
          <div className="card">
            <div className="row">
              <div className="grow">
                <div className="muted">Total fade vs what you sold</div>
                <div className="big">{dollars(d.completed.summary.totalFadeCents)}</div>
              </div>
              <div className="grow">
                <div className="muted">Weighted by contract</div>
                <div className="big">{pct(d.completed.summary.weightedFadeBps)}</div>
              </div>
              <div className="grow">
                <div className="muted">Finished worse / better</div>
                <div className="big">
                  {d.completed.summary.jobsFaded} / {d.completed.summary.jobsImproved}
                </div>
              </div>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>{d.completed.explain}</p>
            <p className="muted" style={{ marginBottom: 0 }}>
              This is the number that decides whether an underwriter believes
              the profit your open jobs say they will make. It comes from the
              WIP snapshots this system has been locking all along — not a
              number anybody typed in later.
            </p>
          </div>

          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Job</th><th>Completed</th>
                  <th style={{ textAlign: "right" }}>Final contract</th>
                  <th style={{ textAlign: "right" }}>Final cost</th>
                  <th style={{ textAlign: "right" }}>Actual GP</th>
                  <th style={{ textAlign: "right" }}>Margin</th>
                  <th style={{ textAlign: "right" }}>GP when sold</th>
                  <th style={{ textAlign: "right" }}>Fade</th>
                  <th style={{ textAlign: "right" }}>vs last review</th>
                  <th style={{ textAlign: "right" }}>Reviews</th>
                </tr>
              </thead>
              <tbody>
                {d.completed.rows.map((r) => (
                  <tr key={r.jobId}>
                    <td>
                      <Link href={`/jobs/${r.jobId}`}>#{r.jobNo} {r.name}</Link>
                      {r.bonded && <span className="pill">bonded</span>}
                    </td>
                    <td className="muted">{r.completedOn ?? "—"}</td>
                    <td style={{ textAlign: "right" }}>{dollars(r.finalContractCents)}</td>
                    <td style={{ textAlign: "right" }}>{dollars(r.finalCostCents)}</td>
                    <td style={{ textAlign: "right" }}>{dollars(r.actualGrossProfitCents)}</td>
                    <td style={{ textAlign: "right" }}>{pct(r.actualGrossMarginBps)}</td>
                    <td style={{ textAlign: "right" }} className="muted">
                      {r.estGrossProfitAtAwardCents === null
                        ? "no budget on file"
                        : dollars(r.estGrossProfitAtAwardCents)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {r.fadeFromAwardCents === null ? (
                        <span className="muted">n/a</span>
                      ) : (
                        <span style={{ color: r.fadeFromAwardCents < 0 ? "var(--danger)" : undefined }}>
                          {dollars(r.fadeFromAwardCents)} {pct(r.fadeFromAwardBps)}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {r.fadeFromLastSnapshotCents === null ? (
                        <span className="muted">n/a</span>
                      ) : (
                        dollars(r.fadeFromLastSnapshotCents)
                      )}
                    </td>
                    <td style={{ textAlign: "right" }} className="muted">{r.snapshotCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.completed.rows.some((r) => r.estGrossProfitAtAwardCents === null) && (
            <p className="muted">
              Jobs showing &quot;no budget on file&quot; have nothing to fade
              from. Set a budget when you win the work and they fill in by
              themselves — a blank is honest, a zero would claim the job
              finished exactly as sold.
            </p>
          )}
        </>
      )}

      {tab === "backlog" && (
        <>
          <div className="card">
            <div className="row">
              <div className="grow">
                <div className="muted">Revenue still ahead</div>
                <div className="big">{dollars(Number(d.backlog.totals.remainingRevenueCents))}</div>
              </div>
              <div className="grow">
                <div className="muted">Gross profit still to earn</div>
                <div className="big">{dollars(Number(d.backlog.totals.remainingGrossProfitCents))}</div>
              </div>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>{d.backlog.explain}</p>
          </div>
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Job</th><th>Customer</th><th>Status</th>
                  <th style={{ textAlign: "right" }}>Contract</th>
                  <th style={{ textAlign: "right" }}>Revenue remaining</th>
                  <th style={{ textAlign: "right" }}>GP remaining</th>
                  <th>Est. completion</th>
                </tr>
              </thead>
              <tbody>
                {d.backlog.rows.map((r) => (
                  <tr key={r.jobId}>
                    <td><Link href={`/jobs/${r.jobId}`}>#{r.jobNo} {r.name}</Link></td>
                    <td>{r.customerName}</td>
                    <td className="muted">{r.status}</td>
                    <td style={{ textAlign: "right" }}>{dollars(r.contractCents)}</td>
                    <td style={{ textAlign: "right" }}>{dollars(r.remainingRevenueCents)}</td>
                    <td style={{ textAlign: "right" }}>{dollars(r.remainingGrossProfitCents)}</td>
                    <td className="muted">{r.estCompletionOn ?? "not set"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "ratios" && (
        <>
          <div className="card">
            <div className="row">
              <div className="grow">
                <div className="muted">Working capital</div>
                <div className="big">{dollars(d.ratios.ratios.workingCapitalCents)}</div>
              </div>
              <div className="grow">
                <div className="muted">Tangible net worth</div>
                <div className="big">{dollars(d.ratios.ratios.tangibleNetWorthCents)}</div>
              </div>
              <div className="grow">
                <div className="muted">Current ratio</div>
                <div className="big">{times(d.ratios.ratios.currentRatioBps)}</div>
              </div>
              <div className="grow">
                <div className="muted">Debt to equity</div>
                <div className="big">{times(d.ratios.ratios.debtToEquityBps)}</div>
              </div>
            </div>
            <div className="row">
              <div className="grow">
                <div className="muted">Revenue ÷ working capital</div>
                <div className="big">{times(d.ratios.ratios.revenueToWorkingCapitalBps)}</div>
              </div>
              <div className="grow">
                <div className="muted">Days in receivables</div>
                <div className="big">{d.ratios.ratios.daysInAr ?? "n/a"}</div>
              </div>
              <div className="grow">
                <div className="muted">Underbillings ÷ equity</div>
                <div className="big">{pct(d.ratios.ratios.underbillingsToEquityBps)}</div>
              </div>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>{d.ratios.explain}</p>
          </div>

          {d.ratios.unclassified && (
            <div className="card" style={{ background: "var(--warn-bg)" }}>
              <strong>Nothing in your chart is classified yet.</strong>
              <p className="muted" style={{ marginBottom: 0 }}>
                Every asset is being counted as <em>current</em> — which is
                right for cash and receivables and wrong for your trucks. Your
                accountant marks long-term assets as non-current, and goodwill
                or anything owed by the owner as intangible or related-party;
                tangible net worth is the number bonding capacity is sized
                from, so it is worth getting right. It is a judgement about
                your specific chart, which is why this asks rather than
                guessing from account names.
              </p>
            </div>
          )}

          {d.ratios.classified.length > 0 && (
            <div className="card">
              <strong>Classified by your accountant</strong>
              {d.ratios.classified.map((a) => (
                <div key={a.code} className="row" style={{ padding: "4px 0" }}>
                  <span className="grow">{a.code} · {a.name}</span>
                  <span className="pill">{a.suretyClass}</span>
                </div>
              ))}
            </div>
          )}

          <h2>Bank lines &amp; term debt</h2>
          <div className="card">
            {d.facilities.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No credit facilities recorded. An underwriter asks for these
                every time — and an <em>unused</em> line is invisible in your
                ledger precisely because it is unused, which is exactly the one
                that makes a shop bondable.
              </p>
            ) : (
              d.facilities.map((f) => (
                <div key={f.id} className="row" style={{ padding: "6px 0" }}>
                  <span className="grow">
                    <strong>{f.lender}</strong> <span className="muted">{f.kind}</span>
                    {f.personallyGuaranteed && <span className="pill">personally guaranteed</span>}
                  </span>
                  <span className="muted">
                    {dollars(f.balanceCents)} drawn of {dollars(f.limitCents)} ·{" "}
                    {dollars(f.limitCents - f.balanceCents)} available
                    {f.maturesOn ? ` · matures ${f.maturesOn}` : ""}
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
