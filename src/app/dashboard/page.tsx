"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";
import {
  DataTable,
  DecisionList,
  KpiRow,
  Section,
  StatusPill,
  type Decision,
  type Kpi,
} from "@/components/dash/Dash";
import { BarChart, LineChart } from "@/components/dash/Chart";

/**
 * The operating dashboard — Monday morning, one screen.
 *
 * The order is the argument: what needs a DECISION, then the numbers that
 * justify it, then the detail behind those. A dashboard that opens with
 * tiles makes the owner do the interpreting; this one does the interpreting
 * and shows its work underneath.
 */

interface Payload {
  asOf: string;
  decisions: Decision[];
  nothingToDo: string;
  cip: {
    rows: {
      jobId: string; jobNo: number; name: string; customerName: string;
      contractCents: number; pctCompleteBps: number; costsToDateCents: number;
      earnedRevenueCents: number; billedToDateCents: number;
      underbilledCents: number; overbilledCents: number;
      estGrossProfitCents: number;
      flags: { lossJob: boolean; staleEtc: boolean };
    }[];
    totals: Record<string, number>;
    explain: string;
    tied: boolean;
  };
  aging: {
    // `late` comes from the aging report itself — never re-derive it from the
    // label here. See the comment on the bucket list in reporting/store.ts.
    buckets: { label: string; amountCents: number; late: boolean }[];
    retainageCents: number;
    totalCents: number;
  };
  kpis: {
    // ⛔ These names are the module's, not guesses. Getting them wrong does
    // not fail the typecheck (the route spreads an `any`-shaped JSON body)
    // and does not fail a test — it renders $NaN and "undefined" on a live
    // dashboard, which is how it was found: by looking at the page.
    revenueThisMonthCents: number;
    avgInvoiceCents: number;
    closeRateBps: number;
    arDays: number;
  };
  scoreboard: { jobs: { jobId: string; name: string }[] } | null;
  cashPlan: {
    // ⛔ weekStart, not label; and the chart plots the running BALANCE, not
    // the week's inflow. Plotting committedCents would draw the money
    // ARRIVING each week — a completely different and meaningless line for
    // the one question this chart exists to answer: does cash run out?
    weeks: {
      weekStart: string;
      committedBalanceCents: number;
      likelyBalanceCents: number;
    }[];
    explain: string;
  } | null;
  lateInvoices: {
    invoiceId: string; invoiceNo: number; customerName: string;
    cents: number; daysLate: number;
  }[];
  lateBills: { billId: string; vendorName: string; cents: number; daysLate: number }[];
  unansweredBankLines: number;
  cashOnHandCents: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const [d, setD] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const showSkeleton = useFirstLoad(d !== null);

  const load = useCallback(async () => {
    try {
      setD(await api<Payload>("/api/dashboard/operating"));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.push("/login");
      } else setError("Couldn't load your dashboard.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!d) {
    return (
      <AppShell title="Dashboard">
        {showSkeleton && <PageSkeleton kind="stats" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  const t = d.cip.totals;
  const lateAr = d.aging.buckets
    .filter((b) => b.late)
    .reduce((s, b) => s + b.amountCents, 0);
  const lateApTotal = d.lateBills.reduce((s, b) => s + b.cents, 0);

  const kpis: Kpi[] = [
    {
      label: "Cash on hand",
      value: dollars(d.cashOnHandCents),
      sub: "Checking and savings only — cards are what you owe",
      href: "/money",
    },
    {
      label: "Owed to you",
      value: dollars(d.aging.totalCents),
      sub:
        lateAr > 0
          ? `${dollars(lateAr)} of it is late`
          : "nothing past due",
      attention: lateAr > 0,
      href: "/reports",
    },
    {
      label: "You owe, already late",
      value: dollars(lateApTotal),
      sub:
        d.lateBills.length > 0
          ? `${d.lateBills.length} bill${d.lateBills.length === 1 ? "" : "s"} — subs can lien`
          : "nothing overdue",
      attention: lateApTotal > 0,
      href: "/purchasing",
    },
    {
      label: "Work done, not billed",
      value: dollars(Number(t.underbilledCents)),
      sub: "money you can invoice today",
      attention: Number(t.underbilledCents) > 0,
      href: "/wip",
    },
    {
      label: "Billed ahead of the work",
      value: dollars(Number(t.overbilledCents)),
      sub: "good for cash, still owed as work",
      href: "/wip",
    },
    {
      label: "Billed this month",
      value: dollars(d.kpis.revenueThisMonthCents),
      sub: `average invoice ${dollars(d.kpis.avgInvoiceCents)}`,
      href: "/reports",
    },
    {
      label: "Estimates won",
      value: `${(d.kpis.closeRateBps / 100).toFixed(0)}%`,
      sub: "of the quotes you sent",
    },
    {
      label: "Days to get paid",
      value: d.kpis.arDays > 0 ? String(d.kpis.arDays) : "n/a",
      sub:
        d.kpis.arDays > 0
          ? "open receivables against the last 90 days of billing"
          : "not enough billing history yet",
    },
  ];

  return (
    <AppShell title="Dashboard">
      <p className="muted" style={{ marginTop: 0 }}>
        As of {d.asOf}. Every figure comes from your own ledger — nothing here
        is estimated except the cost-to-finish you typed in yourself.
      </p>

      <DecisionList
        title="NEEDS A DECISION THIS WEEK"
        decisions={d.decisions}
        emptyText={d.nothingToDo}
      />

      <KpiRow kpis={kpis} />

      {!d.cip.tied && (
        <div className="card" style={{ background: "var(--warn-bg)" }}>
          <strong>Your work-in-progress isn&apos;t on the balance sheet yet.</strong>{" "}
          <span className="muted">
            The over- and under-billings above are computed but not posted, so
            a banker or a surety reading your balance sheet cannot see them.{" "}
            <Link href="/bonding">Post the adjustment</Link> — it takes one
            click and it is the same entry your CPA makes by hand.
          </span>
        </div>
      )}

      {d.cashPlan && d.cashPlan.weeks.length > 1 && (
        <Section
          title="Cash, the next 13 weeks"
          subtitle="if only what's signed happens"
          caveat={d.cashPlan.explain}
        >
          <div className="card">
            <LineChart
              points={d.cashPlan.weeks.map((w, i) => ({
                label: `w${i + 1}`,
                value: Math.round(w.committedBalanceCents / 100),
              }))}
              alt={`Cash across ${d.cashPlan.weeks.length} weeks, counting only signed and scheduled money.`}
              format={(n) => dollars(n * 100)}
            />
          </div>
        </Section>
      )}

      <Section
        title="Money on the street"
        subtitle={`${dollars(d.aging.totalCents)} owed to you · ${dollars(lateAr)} late`}
        caveat="Retainage is shown separately because it is not late — it is being held by contract. Folding it into your aging makes you look slow at collecting when you are simply doing commercial work."
      >
        <div className="card">
          <BarChart
            points={d.aging.buckets.map((b) => ({
              label: b.label,
              value: Math.round(b.amountCents / 100),
            }))}
            alt={`Receivables by age. ${dollars(lateAr)} of ${dollars(d.aging.totalCents)} is past due.`}
            format={(n) => dollars(n * 100)}
          />
          {d.aging.retainageCents > 0 && (
            <p className="muted" style={{ marginBottom: 0 }}>
              Plus <strong>{dollars(d.aging.retainageCents)}</strong> of
              retainage held by customers — earned money you cannot spend yet.
              Never count it as available cash.
            </p>
          )}
        </div>

        <DataTable
          headers={["Customer", "Invoice", "Amount", "Status"]}
          numericFrom={2}
          sortedBy="Sorted oldest first."
          empty="No invoices are past due. That is rarer than it sounds."
          rows={d.lateInvoices.map((i) => [
            i.customerName,
            `#${i.invoiceNo}`,
            dollars(i.cents),
            <StatusPill
              key={i.invoiceId}
              text={`${i.daysLate}d late`}
              tone={i.daysLate >= 30 ? "bad" : "warn"}
            />,
          ])}
        />
      </Section>

      <Section
        title="What you owe"
        subtitle={`${dollars(lateApTotal)} already late`}
        caveat="A sub who is not paid stops showing up, and in most states can put a lien on the job — which becomes your customer's problem and then your reputation."
      >
        <DataTable
          headers={["Vendor", "Amount", "Status"]}
          numericFrom={1}
          sortedBy="Sorted by how late."
          empty="Nothing overdue. Your subs know."
          rows={d.lateBills.map((b) => [
            b.vendorName,
            dollars(b.cents),
            <StatusPill
              key={b.billId}
              text={`${b.daysLate}d late`}
              tone={b.daysLate >= 30 ? "bad" : "warn"}
            />,
          ])}
        />
      </Section>

      <Section
        title="Work in progress"
        subtitle={d.cip.explain}
        caveat="Under- and over-billing never cancel each other out. One is an invoice nobody sent; the other is work you still owe a customer who has already paid."
      >
        <DataTable
          headers={["Job", "Contract", "%", "Costs", "Earned", "Billed", "Under", "Over"]}
          numericFrom={1}
          sortedBy="Sorted by job number."
          empty="No open contracts."
          rows={d.cip.rows.map((r) => [
            <span key={r.jobId}>
              <Link href={`/jobs/${r.jobId}`}>#{r.jobNo} {r.name}</Link>{" "}
              {r.flags.lossJob && <StatusPill text="projected loss" tone="bad" />}
              {r.flags.staleEtc && <StatusPill text="stale estimate" tone="warn" />}
            </span>,
            dollars(r.contractCents),
            `${(r.pctCompleteBps / 100).toFixed(0)}%`,
            dollars(r.costsToDateCents),
            dollars(r.earnedRevenueCents),
            dollars(r.billedToDateCents),
            r.underbilledCents > 0 ? dollars(r.underbilledCents) : "—",
            r.overbilledCents > 0 ? dollars(r.overbilledCents) : "—",
          ])}
        />
      </Section>

      {d.unansweredBankLines > 0 && (
        <p className="muted">
          <strong>{d.unansweredBankLines} bank line
          {d.unansweredBankLines === 1 ? "" : "s"}</strong> still need an
          answer, so everything on this page is working from an incomplete
          picture. <Link href="/bank">Clear them</Link> and these numbers
          become the whole truth.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
