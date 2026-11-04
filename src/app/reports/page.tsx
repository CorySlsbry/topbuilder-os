"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Line {
  code: string;
  name: string;
  amountCents: number;
}
interface Statements {
  pnl: {
    revenue: Line[];
    revenueCents: number;
    costOfSales: Line[];
    costOfSalesCents: number;
    grossProfitCents: number;
    expenses: Line[];
    expensesCents: number;
    netIncomeCents: number;
    explain: string;
  };
  balanceSheet: {
    assets: Line[];
    assetsCents: number;
    liabilities: Line[];
    liabilitiesCents: number;
    equity: Line[];
    equityCents: number;
    currentEarningsCents: number;
    liabilitiesAndEquityCents: number;
    ties: boolean;
    explain: string;
  };
  cashFlow: {
    fromCustomersCents: number;
    forJobsCents: number;
    forOverheadCents: number;
    ownerCents: number;
    taxesAndLoansCents: number;
    netChangeCents: number;
    explain: string;
  };
  trialBalance: {
    rows: { code: string; name: string; debitCents: number; creditCents: number }[];
    totalDebitsCents: number;
    totalCreditsCents: number;
    ties: boolean;
    explain: string;
  };
}
interface Aging {
  buckets: { label: string; amountCents: number }[];
  retainageCents: number;
  totalCents: number;
  explain: string;
}
interface Scoreboard {
  weekStart: string;
  cashCents: number;
  arOpenCents: number;
  jobs: {
    jobId: string;
    jobNo: number;
    name: string;
    status: string;
    costsWeekCents: number;
    invoicedWeekCents: number;
    paidWeekCents: number;
  }[];
  explain: string;
}
interface LirCohort {
  cohortMonth: string;
  tenants: number;
  tenantsThroughLoop: number;
  loopJobs: number;
  rateBps: number;
}

/** Simple horizontal bar chart — no library, WCAG-labeled. */
function Bars({ data }: { data: { label: string; cents: number; color?: string }[] }) {
  const max = Math.max(...data.map((d) => Math.abs(d.cents)), 1);
  return (
    <svg
      viewBox={`0 0 400 ${data.length * 34}`}
      role="img"
      aria-label={data.map((d) => `${d.label}: ${dollars(Math.abs(d.cents))}`).join("; ")}
      style={{ width: "100%", maxWidth: 560 }}
    >
      {data.map((d, i) => (
        <g key={d.label} transform={`translate(0 ${i * 34})`}>
          <text x="0" y="12" fontSize="11" fill="var(--muted, #667)">
            {d.label}
          </text>
          <rect
            x="0"
            y="16"
            height="12"
            rx="3"
            width={Math.max((Math.abs(d.cents) / max) * 400, 2)}
            fill={d.color ?? (d.cents >= 0 ? "#2f855a" : "#c53030")}
          />
          <text x={Math.min((Math.abs(d.cents) / max) * 400 + 6, 330)} y="26" fontSize="11" fill="currentColor">
            {dollars(Math.abs(d.cents))}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default function ReportsPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [stmts, setStmts] = useState<Statements | null>(null);
  const [aging, setAging] = useState<Aging | null>(null);
  const [score, setScore] = useState<Scoreboard | null>(null);
  const [lir, setLir] = useState<{ cohorts: LirCohort[]; targetBps: number } | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [showTb, setShowTb] = useState(false);
  const [error, setError] = useState("");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ to });
      if (from) q.set("from", from);
      const r = await api<{ statements: Statements; aging: Aging; scoreboard: Scoreboard }>(
        `/api/reports/statements?${q}`,
      );
      setStmts(r.statements);
      setAging(r.aging);
      setScore(r.scoreboard);
        setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load the reports.");
    }
    // Operator-only; 404 for everyone else — just hide the section.
    try {
      setLir(await api<{ cohorts: LirCohort[]; targetBps: number }>("/api/admin/lir"));
    } catch {
      setLir(null);
    }
  }, [router, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const packUrl = `/api/reports/pack?to=${to}${from ? `&from=${from}` : ""}`;

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Reports">
        {showSkeleton && <PageSkeleton kind="stats" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Reports">
      <div className="card">
        <div className="row">
          <div>
            <label htmlFor="rfrom">From (optional)</label>
            <input id="rfrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label htmlFor="rto">Through</label>
            <input id="rto" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <a
            className="pill"
            style={{ alignSelf: "flex-end", padding: "10px 14px", textDecoration: "none" }}
            href={packUrl}
            download
          >
            📦 Download the CPA pack
          </a>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          The pack is six CSV files — trial balance, full general ledger, P&L,
          balance sheet, AR aging, and the WIP schedule. Any accountant can
          open them in Excel or import them to their own software. Your data
          is never locked in.
        </p>
      </div>

      {score && (
        <>
          <h2>This week</h2>
          <div className="card">
            <p style={{ marginTop: 0 }}>{score.explain}</p>
            <Bars
              data={[
                { label: "In the bank", cents: score.cashCents, color: "#2f855a" },
                { label: "Owed to you", cents: score.arOpenCents, color: "#2b6cb0" },
              ]}
            />
            {score.jobs.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Spent this week</th>
                    <th>Billed this week</th>
                    <th>Collected this week</th>
                  </tr>
                </thead>
                <tbody>
                  {score.jobs.map((j) => (
                    <tr key={j.jobId}>
                      <td>
                        <Link href={`/jobs/${j.jobId}`}>
                          #{j.jobNo} {j.name}
                        </Link>
                      </td>
                      <td>{dollars(j.costsWeekCents)}</td>
                      <td>{dollars(j.invoicedWeekCents)}</td>
                      <td>{dollars(j.paidWeekCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {stmts && (
        <>
          <h2>Profit &amp; loss</h2>
          <div className="card">
            <Bars
              data={[
                { label: "Sales", cents: stmts.pnl.revenueCents, color: "#2b6cb0" },
                { label: "Cost of the jobs", cents: -stmts.pnl.costOfSalesCents },
                { label: "Running the business", cents: -stmts.pnl.expensesCents },
                { label: "Profit", cents: stmts.pnl.netIncomeCents },
              ]}
            />
            <p className="muted" style={{ marginBottom: 0 }}>{stmts.pnl.explain}</p>
          </div>

          <h2>Balance sheet</h2>
          <div className="card">
            <Bars
              data={[
                { label: "What you own", cents: stmts.balanceSheet.assetsCents, color: "#2f855a" },
                { label: "What you owe", cents: -stmts.balanceSheet.liabilitiesCents },
                { label: "Yours (equity)", cents: stmts.balanceSheet.equityCents, color: "#2b6cb0" },
              ]}
            />
            <p className="muted">{stmts.balanceSheet.explain}</p>
            {!stmts.balanceSheet.ties && (
              <p className="error" style={{ marginBottom: 0 }}>
                ⚠ The balance sheet does not tie — call your bookkeeper.
              </p>
            )}
          </div>

          <h2>Cash flow</h2>
          <div className="card">
            <Bars
              data={[
                { label: "From customers", cents: stmts.cashFlow.fromCustomersCents, color: "#2f855a" },
                { label: "Job costs", cents: stmts.cashFlow.forJobsCents },
                { label: "Overhead", cents: stmts.cashFlow.forOverheadCents },
                { label: "Owner", cents: stmts.cashFlow.ownerCents },
                { label: "Taxes & loans", cents: stmts.cashFlow.taxesAndLoansCents },
                { label: "Net change", cents: stmts.cashFlow.netChangeCents, color: "#2b6cb0" },
              ]}
            />
            <p className="muted" style={{ marginBottom: 0 }}>{stmts.cashFlow.explain}</p>
          </div>

          {aging && (
            <>
              <h2>Who owes you</h2>
              <div className="card">
                <Bars
                  data={[
                    ...aging.buckets.map((b) => ({ label: b.label, cents: b.amountCents, color: "#2b6cb0" })),
                    { label: "Retainage held", cents: aging.retainageCents, color: "#805ad5" },
                  ]}
                />
                <p className="muted" style={{ marginBottom: 0 }}>{aging.explain}</p>
              </div>
            </>
          )}

          <h2>
            Trial balance{" "}
            <button className="secondary" onClick={() => setShowTb((s) => !s)}>
              {showTb ? "Hide" : "Show"}
            </button>
          </h2>
          {showTb && (
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Debit</th>
                    <th>Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {stmts.trialBalance.rows.map((r) => (
                    <tr key={r.code}>
                      <td>
                        {r.code} {r.name}
                      </td>
                      <td>{r.debitCents ? dollars(r.debitCents) : ""}</td>
                      <td>{r.creditCents ? dollars(r.creditCents) : ""}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <strong>Total</strong>
                    </td>
                    <td>
                      <strong>{dollars(stmts.trialBalance.totalDebitsCents)}</strong>
                    </td>
                    <td>
                      <strong>{dollars(stmts.trialBalance.totalCreditsCents)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="muted" style={{ marginBottom: 0 }}>{stmts.trialBalance.explain}</p>
            </div>
          )}
        </>
      )}

      {lir && (
        <>
          <h2>LIR cohorts (platform)</h2>
          <div className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              Target: {lir.targetBps / 100}% of new shops run ≥3 jobs through the
              complete loop within 45 days.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Cohort</th>
                  <th>Shops</th>
                  <th>Through the loop</th>
                  <th>Rate</th>
                </tr>
              </thead>
              <tbody>
                {lir.cohorts.map((c) => (
                  <tr key={c.cohortMonth}>
                    <td>{c.cohortMonth}</td>
                    <td>{c.tenants}</td>
                    <td>{c.tenantsThroughLoop}</td>
                    <td style={{ color: c.rateBps >= lir.targetBps ? "#2f855a" : "#c53030" }}>
                      {(c.rateBps / 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
