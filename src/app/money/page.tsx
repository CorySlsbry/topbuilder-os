"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import AskBooks from "@/components/AskBooks";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface CashPlanWeek {
  weekStart: string;
  committedCents: number;
  likelyCents: number;
  possibleCents: number;
  committedBalanceCents: number;
  likelyBalanceCents: number;
  possibleBalanceCents: number;
}
interface CashPlan {
  startingCashCents: number;
  weeks: CashPlanWeek[];
  beyondCents: number;
  lag: { days: number; samples: number; isDefault: boolean };
  items: { week: number; cents: number; certainty: string; label: string }[];
  overclaimed: { jobId: string; claimedCents: number; availableCents: number }[];
  explain: string;
}

interface Kpis {
  revenueThisMonthCents: number;
  avgInvoiceCents: number;
  closeRateBps: number;
  arDays: number;
  explain: string;
}
interface Tax {
  byMonth: { month: string; collectedCents: number; remitted: boolean }[];
  liabilityCents: number;
  explain: string;
}
interface Period {
  periodStart: string;
  status: string;
}

export default function MoneyPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [plan, setPlan] = useState<CashPlan | null>(null);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [tax, setTax] = useState<Tax | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [lockMonth, setLockMonth] = useState("");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      // The cash plan is fetched BESIDE the old forecast, not instead of it:
      // the forecast answers a narrower question (what is already owed) and
      // other screens still read it. Two honest reports beat one that tries
      // to be both.
      const [f, t, p, cashPlan] = await Promise.all([
        // Still fetched for its KPI block; the chart it used to draw was
        // replaced by the plan below.
        api<{ kpis: Kpis }>("/api/reports/forecast"),
        api<Tax>("/api/tax"),
        api<{ periods: Period[] }>("/api/periods"),
        api<CashPlan>("/api/reports/cash-plan"),
      ]);
      setPlan(cashPlan);
      setKpis(f.kpis);
      setTax(t);
      setPeriods(p.periods);
        setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load Money HQ.");
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
        e instanceof ApiError && e.code === "period_already_remitted"
          ? "That month's tax is already remitted."
          : "That didn't work — check the fields and try again.",
      );
    } finally {
      setBusy(false);
      await load();
    }
  }

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Money HQ">
        {showSkeleton && <PageSkeleton kind="stats" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Money HQ">
      <AskBooks />

      {kpis && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>How the business is doing</h2>
          <div className="row">
            <span className="pill">Billed this month: <strong>{dollars(kpis.revenueThisMonthCents)}</strong></span>
            <span className="pill">Average invoice: <strong>{dollars(kpis.avgInvoiceCents)}</strong></span>
            <span className="pill">Estimates won: <strong>{Math.round(kpis.closeRateBps / 100)}%</strong></span>
            <span className="pill">Days to get paid: <strong>{kpis.arDays}</strong></span>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>{kpis.explain}</p>
        </div>
      )}

      {/*
        The older "Cash, 13 weeks ahead" chart used to live here and was
        REMOVED from this screen when the plan below shipped.

        Not because it was wrong — it answers a narrower question honestly, and
        /api/reports/forecast is still there for anything that wants it. It was
        removed because two cash charts on one screen, drawn from overlapping
        data with different rules, is how an owner ends up asking which of
        their own numbers is the real one. The screen picks one.

        The forecast fetch stays: this page's KPI card comes from the same
        response.
      */}

      {plan && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>The next 13 weeks</h2>

          {/* Three lines because there are three answers. Collapsing them into
              one is how a hedge becomes a prediction, and there are NO
              percentages anywhere on this card on purpose: a percentage
              invites the reader to multiply by it. */}
          <svg
            viewBox="0 0 650 140"
            role="img"
            aria-label={plan.explain}
            style={{ width: "100%" }}
          >
            {(() => {
              const all = plan.weeks.flatMap((w) => [
                w.committedBalanceCents,
                w.likelyBalanceCents,
                w.possibleBalanceCents,
              ]);
              const hi = Math.max(1, ...all);
              const lo = Math.min(0, ...all);
              const span = hi - lo || 1;
              const y = (c: number) => 110 - ((c - lo) / span) * 95;
              const x = (i: number) => 10 + i * (630 / Math.max(1, plan.weeks.length - 1));
              const path = (pick: (w: CashPlanWeek) => number) =>
                plan.weeks.map((w, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(pick(w))}`).join(" ");
              const zero = y(0);
              return (
                <>
                  {lo < 0 && (
                    <line x1="10" y1={zero} x2="640" y2={zero} stroke="var(--danger)"
                          strokeDasharray="4 4" strokeWidth="1" />
                  )}
                  <path d={path((w) => w.possibleBalanceCents)} fill="none"
                        stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="3 3" />
                  <path d={path((w) => w.likelyBalanceCents)} fill="none"
                        stroke="var(--brand)" strokeWidth="2" />
                  <path d={path((w) => w.committedBalanceCents)} fill="none"
                        stroke="#2f855a" strokeWidth="2.5" />
                  {plan.weeks.map((w, i) =>
                    i % 2 === 0 ? (
                      <text key={w.weekStart} x={x(i)} y="130" fontSize="9"
                            textAnchor="middle" fill="var(--muted)">
                        {w.weekStart.slice(5)}
                      </text>
                    ) : null,
                  )}
                </>
              );
            })()}
          </svg>

          <div className="row" style={{ fontSize: "0.82rem", gap: 14, flexWrap: "wrap" }}>
            <span><strong style={{ color: "#2f855a" }}>———</strong> Only what&apos;s signed</span>
            <span><strong style={{ color: "var(--brand)" }}>———</strong> If the calendar holds</span>
            <span><strong className="muted">- - -</strong> If the backlog bills too</span>
          </div>

          <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>{plan.explain}</p>

          {plan.overclaimed.length > 0 && (
            // Should never appear. It is surfaced rather than swallowed
            // because a silent violation inflates the plan, and an owner makes
            // hiring decisions on this number.
            <div className="banner" style={{ marginTop: 10 }}>
              <strong>Something doesn&apos;t add up:</strong> {plan.overclaimed.length} job
              {plan.overclaimed.length === 1 ? " has" : "s have"} more money planned than
              contract left. Tell us — this is a bug, not something you did.
            </div>
          )}

          <details style={{ marginTop: 10 }}>
            <summary className="muted" style={{ cursor: "pointer" }}>
              What&apos;s in this? ({plan.items.length} item{plan.items.length === 1 ? "" : "s"})
            </summary>
            {/* Every row a person can check. That is the whole trust
                mechanism: certainty here is a CATEGORY you can argue with, not
                a score you cannot. */}
            <div style={{ marginTop: 8 }}>
              {plan.items.map((it, i) => (
                <div key={i} className="row" style={{ fontSize: "0.85rem", padding: "3px 0" }}>
                  <span className="pill">{it.certainty}</span>
                  <span className="grow">{it.label}</span>
                  <span style={{ color: it.cents < 0 ? "var(--danger)" : "inherit" }}>
                    {it.cents < 0 ? "-" : "+"}
                    {dollars(Math.abs(it.cents))}
                  </span>
                </div>
              ))}
              {plan.items.length === 0 && (
                <p className="muted" style={{ margin: 0 }}>
                  Nothing dated yet. Issue an invoice or put a job on the board and it
                  shows up here.
                </p>
              )}
            </div>
          </details>
        </div>
      )}

      {tax && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Sales tax</h2>
          <p style={{ marginTop: 0 }}>{tax.explain}</p>
          {tax.byMonth.map((m) => (
            <div className="row" key={m.month}>
              <span className="grow">{m.month}: {dollars(m.collectedCents)} collected</span>
              {m.remitted ? (
                <span className="pill">remitted ✓</span>
              ) : (
                <button
                  className="secondary"
                  disabled={busy || tax.liabilityCents <= 0}
                  onClick={() =>
                    void act(
                      () =>
                        api("/api/tax", {
                          method: "POST",
                          json: {
                            periodLabel: m.month,
                            amountCents: m.collectedCents,
                            remittedOn: new Date().toISOString().slice(0, 10),
                          },
                        }),
                      `Remitted ${m.month} — the liability account is cleared and the payment is on the books.`,
                    )
                  }
                >
                  Mark remitted
                </button>
              )}
            </div>
          ))}
          {tax.byMonth.length === 0 && <p className="muted" style={{ margin: 0 }}>No taxable invoices yet.</p>}
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Labor on your jobs</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Every hour your crew logs lands on its job at what it truly costs you
          &mdash; the wage plus payroll taxes, workers&rsquo; comp at that
          worker&rsquo;s class rate, and overtime past 40. That is what makes
          &ldquo;what did this job make me&rdquo; an honest number instead of a
          guess.
        </p>
        <p className="muted">
          <strong>We do not run your payroll.</strong> ADP does that, and files
          your taxes and your certified payroll. When ADP&rsquo;s draft hits your
          bank, match it in <a href="/bank">Bank</a> and the wages you already
          accrued clear themselves &mdash; no double entry, no second system to
          keep in step.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Lock a month</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          A locked month can never change — the database refuses new postings
          into it. Fixes afterward are reversing entries in an open month,
          the way a CPA expects.
        </p>
        <div className="row">
          <input
            type="month"
            value={lockMonth}
            onChange={(e) => setLockMonth(e.target.value)}
            aria-label="Month to lock"
          />
          <button
            className="secondary"
            disabled={busy || !lockMonth}
            onClick={() =>
              void act(
                () => api("/api/periods", { method: "POST", json: { periodStart: `${lockMonth}-01` } }),
                `${lockMonth} is locked.`,
              )
            }
          >
            🔒 Lock it
          </button>
          {periods.filter((p) => p.status === "closed").length > 0 && (
            <span className="muted" style={{ alignSelf: "center" }}>
              Locked: {periods.filter((p) => p.status === "closed").map((p) => p.periodStart.slice(0, 7)).join(", ")}
            </span>
          )}
        </div>
      </div>

      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
