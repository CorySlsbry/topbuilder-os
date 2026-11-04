"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";
import {
  api,
  ApiError,
  centsFromInput,
  dollars,
  newIdempotencyKey,
} from "@/lib/client/api";

interface Plan {
  id: string;
  name: string;
  billing: "monthly" | "annual";
  priceCents: number;
  visitsPerYear: number;
  discountBps: number;
  targetMonths: number[];
  active: boolean;
  memberCount: number;
}
interface Agreement {
  id: string;
  planName: string;
  billing: "monthly" | "annual";
  priceCents: number;
  customerId: string;
  customerName: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  canceledAt: string | null;
  visitsPerYear: number;
  visitsCompleted: number;
  deferredBalanceCents: number;
  autopay: boolean;
}
interface Visit {
  id: string;
  planName: string;
  customerName: string;
  dueOn: string;
  status: string;
}
interface Customer {
  id: string;
  name: string;
}

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export default function MembershipsPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  // new plan form
  const [pName, setPName] = useState("");
  const [pBilling, setPBilling] = useState<"annual" | "monthly">("annual");
  const [pPrice, setPPrice] = useState("");
  const [pVisits, setPVisits] = useState("2");
  const [pDiscount, setPDiscount] = useState("15");
  const [pMonths, setPMonths] = useState<number[]>([4, 10]);
  // enroll form
  const [ePlan, setEPlan] = useState("");
  const [eCustomer, setECustomer] = useState("");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      const [a, c, v] = await Promise.all([
        api<{ plans: Plan[]; agreements: Agreement[] }>("/api/agreements"),
        api<{ customers: Customer[] }>("/api/customers"),
        api<{ visits: Visit[] }>("/api/agreements/visits?status=due"),
      ]);
      setPlans(a.plans);
      setAgreements(a.agreements);
      setCustomers(c.customers);
      setVisits(v.visits);
      setEPlan((cur) => cur || a.plans.find((p) => p.active)?.id || "");
      setECustomer((cur) => cur || c.customers[0]?.id || "");
        setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load memberships.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(json: Record<string, unknown>, okNote: string) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api("/api/agreements", {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        json,
      });
      setNote(okNote);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work — try again.");
    } finally {
      setBusy(false);
      await load();
    }
  }

  const priceCents = centsFromInput(pPrice);
  const planMissing = [
    !pName.trim() && "a name",
    priceCents === null && "a price",
  ].filter(Boolean) as string[];

  const planFor = (id: string) => plans.find((p) => p.id === id);

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Memberships">
        {showSkeleton && <PageSkeleton kind="list" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Memberships">
      <div className="card">
        <p style={{ marginTop: 0, marginBottom: 0 }}>
          Your service agreements — the plans that smooth the seasonal swing
          and keep customers calling <em>you</em>. Annual money sits as{" "}
          <strong>deferred income (2430)</strong> and becomes revenue as
          tune-ups are completed; monthly plans earn each month. The books do
          this on their own — you just run the visits.
        </p>
      </div>

      {/* ------------------------------------------------ tune-ups due */}
      {visits.length > 0 && (
        <>
          <h2>Tune-ups to schedule <span className="muted" style={{ fontWeight: 400 }}>· {visits.length}</span></h2>
          <div className="card">
            {visits.map((v) => (
              <div key={v.id} className="row" style={{ padding: "6px 0", alignItems: "center" }}>
                <span className="grow">
                  <strong>{v.customerName}</strong> — {v.planName}
                  <span className="muted"> · due {v.dueOn.slice(0, 7)}</span>
                </span>
                <span className="muted" style={{ fontSize: "0.85rem" }}>
                  Book it from Intake or Dispatch, then mark it done on the job.
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ---------------------------------------------------- members */}
      <h2>Members <span className="muted" style={{ fontWeight: 400 }}>· {agreements.filter((a) => a.status === "active").length} active</span></h2>
      <div className="card">
        {agreements.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No members yet — enroll your first below.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Plan</th>
                <th>Visits</th>
                <th>Still deferred</th>
                <th>Period</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {agreements.map((a) => (
                <tr key={a.id}>
                  <td>{a.customerName}</td>
                  <td>
                    {a.planName}{" "}
                    <span className="muted">
                      · {a.billing === "annual" ? `${dollars(a.priceCents)}/yr` : `${dollars(a.priceCents)}/mo`}
                      {a.autopay ? " · autopay" : ""}
                    </span>
                    {a.status !== "active" && <span className="pill"> {a.status}</span>}
                    {a.canceledAt && a.status === "active" && (
                      <span className="pill"> ends {a.periodEnd}</span>
                    )}
                  </td>
                  <td>
                    {a.visitsCompleted}/{a.visitsPerYear}
                  </td>
                  <td>{a.billing === "annual" ? dollars(a.deferredBalanceCents) : "—"}</td>
                  <td className="muted">
                    {a.periodStart} → {a.periodEnd}
                  </td>
                  <td>
                    {a.status === "active" && !a.canceledAt && (
                      <button
                        className="secondary"
                        style={{ minHeight: 34, padding: "4px 12px" }}
                        disabled={busy}
                        onClick={() =>
                          void act(
                            { action: "cancel", agreementId: a.id },
                            "Canceled — their benefits run to the period end, then it stops.",
                          )
                        }
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="row" style={{ marginTop: 14, alignItems: "end" }}>
          <div>
            <label htmlFor="e-plan">Plan</label>
            <select id="e-plan" value={ePlan} onChange={(e) => setEPlan(e.target.value)}>
              {plans.filter((p) => p.active).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.billing === "annual" ? `${dollars(p.priceCents)}/yr` : `${dollars(p.priceCents)}/mo`}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="e-cust">Customer</label>
            <select id="e-cust" value={eCustomer} onChange={(e) => setECustomer(e.target.value)}>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <button
            disabled={busy || !ePlan || !eCustomer}
            onClick={() =>
              void act(
                {
                  action: "enroll",
                  planId: ePlan,
                  customerId: eCustomer,
                  startOn: new Date().toISOString().slice(0, 10),
                },
                planFor(ePlan)?.billing === "annual"
                  ? "Enrolled — the year's invoice is on their account and the tune-ups are scheduled."
                  : "Enrolled — first month billed. Add a card in their portal to switch on autopay.",
              )
            }
          >
            Enroll
          </button>
          {planFor(ePlan)?.billing === "monthly" && (
            <span className="muted" style={{ fontSize: "0.85rem" }}>
              Monthly plans autopay once the customer saves a card in their portal.
            </span>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------ plans */}
      <h2>Plans</h2>
      <div className="card">
        {plans.map((p) => (
          <div key={p.id} className="row" style={{ padding: "6px 0", alignItems: "center" }}>
            <span className="grow">
              <strong>{p.name}</strong>{" "}
              <span className="muted">
                · {p.billing === "annual" ? `${dollars(p.priceCents)}/yr` : `${dollars(p.priceCents)}/mo`}
                · {p.visitsPerYear} {p.visitsPerYear === 1 ? "visit" : "visits"}/yr
                {p.discountBps > 0 ? ` · ${(p.discountBps / 100).toFixed(0)}% off repairs` : ""}
                {p.targetMonths.length > 0
                  ? ` · ${p.targetMonths.map((m) => MONTH_NAMES[m - 1]).join("/")}`
                  : ""}
                · {p.memberCount} {p.memberCount === 1 ? "member" : "members"}
              </span>
              {!p.active && <span className="pill"> retired</span>}
            </span>
            <button
              className="secondary"
              style={{ minHeight: 34, padding: "4px 12px" }}
              disabled={busy}
              onClick={() =>
                void act(
                  { action: "set-plan-active", planId: p.id, active: !p.active },
                  p.active ? "Plan retired — existing members keep it; nobody new joins." : "Plan reactivated.",
                )
              }
            >
              {p.active ? "Retire" : "Reactivate"}
            </button>
          </div>
        ))}

        <div style={{ marginTop: 14 }}>
          <div className="row" style={{ alignItems: "end" }}>
            <div className="grow">
              <label htmlFor="p-name">New plan name</label>
              <input id="p-name" value={pName} onChange={(e) => setPName(e.target.value.slice(0, 120))} placeholder="Comfort Club" />
            </div>
            <div>
              <label htmlFor="p-billing">Billing</label>
              <select id="p-billing" value={pBilling} onChange={(e) => setPBilling(e.target.value as "annual" | "monthly")}>
                <option value="annual">Annual (prepaid)</option>
                <option value="monthly">Monthly (autopay)</option>
              </select>
            </div>
            <div>
              <label htmlFor="p-price">{pBilling === "annual" ? "Price / year" : "Price / month"}</label>
              <input id="p-price" value={pPrice} onChange={(e) => setPPrice(e.target.value)} inputMode="decimal" placeholder={pBilling === "annual" ? "$229.00" : "$19.00"} style={{ width: 120 }} />
            </div>
            <div>
              <label htmlFor="p-visits">Visits / yr</label>
              <input id="p-visits" value={pVisits} onChange={(e) => setPVisits(e.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" style={{ width: 80 }} />
            </div>
            <div>
              <label htmlFor="p-disc">% off repairs</label>
              <input id="p-disc" value={pDiscount} onChange={(e) => setPDiscount(e.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" style={{ width: 90 }} />
            </div>
          </div>
          <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
            <span className="muted" style={{ fontSize: "0.9rem" }}>Visit months:</span>
            {MONTH_NAMES.map((m, i) => {
              const on = pMonths.includes(i + 1);
              return (
                <button
                  key={m}
                  className="chip"
                  aria-pressed={on}
                  onClick={() =>
                    setPMonths((cur) =>
                      on ? cur.filter((x) => x !== i + 1) : [...cur, i + 1].sort((a, b) => a - b),
                    )
                  }
                >
                  {m}
                </button>
              );
            })}
          </div>
          <div className="row" style={{ marginTop: 10, alignItems: "center" }}>
            <button
              disabled={busy || planMissing.length > 0}
              onClick={() =>
                void act(
                  {
                    action: "create-plan",
                    name: pName.trim(),
                    billing: pBilling,
                    priceCents: priceCents ?? 0,
                    visitsPerYear: Number(pVisits || "0"),
                    discountBps: Number(pDiscount || "0") * 100,
                    targetMonths: pMonths,
                  },
                  "Plan created — enroll your first member above.",
                ).then(() => {
                  setPName("");
                  setPPrice("");
                })
              }
            >
              Create plan
            </button>
            {planMissing.length > 0 && (
              <span className="muted" style={{ fontSize: "0.9rem" }}>
                Still needs {planMissing.join(" and ")}
              </span>
            )}
          </div>
        </div>
      </div>

      <div role="status" aria-live="polite">
        {note && <p className="gain">{note}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </AppShell>
  );
}
