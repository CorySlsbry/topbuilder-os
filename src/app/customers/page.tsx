"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  jobCount: number;
  openArCents: number;
  lastJobAt: string | null;
}
interface Unit {
  id: string;
  label: string;
  kind: string;
  make: string;
  model: string;
  serial: string;
  installedOn: string | null;
  warrantyUntil: string | null;
  retired: boolean;
  history: { jobId: string; jobNo: number; jobName: string; on: string }[];
}
interface Membership {
  id: string;
  planName: string;
  billing: string;
  status: string;
  periodEnd: string;
  visitsPerYear: number;
  visitsCompleted: number;
}

const KINDS = [
  { key: "ac", label: "AC / condenser" },
  { key: "furnace", label: "Furnace" },
  { key: "heat-pump", label: "Heat pump" },
  { key: "mini-split", label: "Mini-split" },
  { key: "water-heater", label: "Water heater" },
  { key: "rtu", label: "Rooftop unit" },
  { key: "other", label: "Other" },
] as const;

export default function CustomersPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  // The expanded customer's world, lazy-loaded on open.
  const [openId, setOpenId] = useState<string | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [detailBusy, setDetailBusy] = useState(false);
  // add-a-unit form
  const [uLabel, setULabel] = useState("");
  const [uKind, setUKind] = useState<string>("ac");
  const [uMake, setUMake] = useState("");
  const [uModel, setUModel] = useState("");
  const [uSerial, setUSerial] = useState("");
  // contact editor (per open customer)
  const [cPhone, setCPhone] = useState("");
  const [cEmail, setCEmail] = useState("");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      const r = await api<{ customers: Customer[] }>("/api/customers");
      setCustomers(r.customers);
        setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load customers.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(customerId: string) {
    if (openId === customerId) {
      setOpenId(null);
      return;
    }
    setOpenId(customerId);
    setDetailBusy(true);
    setUnits([]);
    setMemberships([]);
    setCPhone("");
    setCEmail("");
    try {
      const [eq, ag] = await Promise.all([
        api<{ equipment: Unit[] }>(`/api/equipment?customerId=${customerId}`),
        api<{ agreements: Membership[] }>(`/api/agreements?customerId=${customerId}`),
      ]);
      setUnits(eq.equipment);
      setMemberships(ag.agreements);
    } catch {
      setError("Couldn't load that customer's details.");
    } finally {
      setDetailBusy(false);
    }
  }

  async function addUnit(customerId: string) {
    setBusy(true);
    setError("");
    try {
      await api("/api/equipment", {
        method: "POST",
        json: {
          action: "create",
          customerId,
          label: uLabel.trim(),
          kind: uKind,
          ...(uMake.trim() ? { make: uMake.trim() } : {}),
          ...(uModel.trim() ? { model: uModel.trim() } : {}),
          ...(uSerial.trim() ? { serial: uSerial.trim() } : {}),
        },
      });
      setULabel("");
      setUMake("");
      setUModel("");
      setUSerial("");
      setNote("Unit saved — it starts collecting history with the next job.");
      const eq = await api<{ equipment: Unit[] }>(`/api/equipment?customerId=${customerId}`);
      setUnits(eq.equipment);
    } catch {
      setError("Couldn't save the unit.");
    } finally {
      setBusy(false);
    }
  }

  async function retireUnit(customerId: string, id: string) {
    setBusy(true);
    try {
      await api("/api/equipment", {
        method: "POST",
        json: { action: "update", id, retired: true },
      });
      const eq = await api<{ equipment: Unit[] }>(`/api/equipment?customerId=${customerId}`);
      setUnits(eq.equipment);
      setNote("Unit retired — its history stays on the record.");
    } catch {
      setError("Couldn't retire the unit.");
    } finally {
      setBusy(false);
    }
  }

  async function saveContact(customerId: string) {
    setBusy(true);
    setError("");
    try {
      await api("/api/customers", {
        method: "POST",
        json: {
          action: "contact",
          customerId,
          ...(cPhone.trim() ? { phone: cPhone.trim() } : {}),
          ...(cEmail.trim() ? { email: cEmail.trim() } : {}),
        },
      });
      setCPhone("");
      setCEmail("");
      setNote("Saved — you can text or email them now.");
      await load();
    } catch {
      setError("Couldn't save their contact details.");
    } finally {
      setBusy(false);
    }
  }

  async function message(customerId: string) {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ id: string }>("/api/inbox", {
        method: "POST",
        json: { action: "open-for-customer", customerId },
      });
      router.push(`/inbox?thread=${r.id}`);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "customer_has_no_contact"
          ? "This customer has no phone or email on file yet."
          : "Couldn't open a conversation with them.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function portalLink(customerId: string) {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ url: string }>("/api/customers", {
        method: "POST",
        json: { action: "portal-link", customerId },
      });
      const full = `${window.location.origin}${r.url}`;
      await navigator.clipboard.writeText(full).catch(() => {});
      setNote(`Portal link copied — text it to the customer: ${full}`);
    } catch {
      setError("Couldn't make the link.");
    } finally {
      setBusy(false);
    }
  }

  async function askFrontDesk() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ reviewsProposed: number; dunningProposed: number }>(
        "/api/agents/crm/run",
        { method: "POST", json: {} },
      );
      setNote(
        r.reviewsProposed + r.dunningProposed > 0
          ? `Drafted ${r.reviewsProposed} review ask${r.reviewsProposed === 1 ? "" : "s"} and ${r.dunningProposed} payment reminder${r.dunningProposed === 1 ? "" : "s"} — approve under Helpers. Nothing sends without you.`
          : "Nothing to draft — no finished-and-paid jobs waiting on reviews, no invoices past 30 days.",
      );
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "agent_off"
          ? "The Front Desk is off — flip it to 'Ask first' under Helpers."
          : "Couldn't run the Front Desk — try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Customers">
        {showSkeleton && <PageSkeleton kind="list" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Customers">
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          Everyone you&apos;ve worked for, what they owe, and their portal
          link — a private page where they see their jobs and invoices and
          can approve estimates.{" "}
          <button className="secondary" disabled={busy} onClick={() => void askFrontDesk()}>
            🤝 Ask the Front Desk
          </button>{" "}
          It drafts review asks for finished jobs and friendly reminders for
          old invoices — you approve every message.
        </p>
      </div>

      <div className="card">
        {customers.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No customers yet — they arrive with intake.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Contact</th>
                <th>Jobs</th>
                <th>Owes you</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <Fragment key={c.id}>
                  <tr>
                    <td>
                      {/* The name opens the customer's world: their units,
                          their membership, their history. */}
                      <button
                        className="linklike"
                        style={{
                          background: "none",
                          border: 0,
                          padding: 0,
                          minHeight: 0,
                          cursor: "pointer",
                          font: "inherit",
                          color: "inherit",
                        }}
                        aria-expanded={openId === c.id}
                        onClick={() => void openDetail(c.id)}
                      >
                        <strong>{openId === c.id ? "▾ " : "▸ "}{c.name}</strong>
                      </button>
                    </td>
                    <td className="muted">{c.phone ?? c.email ?? "—"}</td>
                    <td>{c.jobCount}</td>
                    <td>{c.openArCents > 0 ? <strong>{dollars(c.openArCents)}</strong> : "—"}</td>
                    <td>
                      {/* Find-or-create: one thread per person, forever. This
                          never starts a second conversation with someone you
                          are already talking to. */}
                      <button className="secondary" disabled={busy} onClick={() => void message(c.id)}>
                        💬 Message
                      </button>{" "}
                      <button className="secondary" disabled={busy} onClick={() => void portalLink(c.id)}>
                        🔗 Portal link
                      </button>
                    </td>
                  </tr>
                  {openId === c.id && (
                    <tr>
                      <td colSpan={5} style={{ background: "var(--panel, rgba(0,0,0,0.02))" }}>
                        {detailBusy ? (
                          <p className="muted" style={{ margin: "8px 0" }}>Loading…</p>
                        ) : (
                          <div style={{ padding: "6px 0 10px" }}>
                            {/* ---------------- how to reach them
                                A customer created from a job has a name and
                                nothing else. Without this there was no way to
                                add a number to them anywhere in the product,
                                so texting them was impossible by design. */}
                            <strong>How to reach them</strong>
                            <div className="row" style={{ margin: "6px 0 14px" }}>
                              <label htmlFor={`ph-${c.id}`} className="sr-only">Phone</label>
                              <input
                                id={`ph-${c.id}`}
                                value={cPhone}
                                placeholder={c.phone || "Phone"}
                                onChange={(e) => setCPhone(e.target.value)}
                                style={{ maxWidth: 170 }}
                              />
                              <label htmlFor={`em-${c.id}`} className="sr-only">Email</label>
                              <input
                                id={`em-${c.id}`}
                                value={cEmail}
                                placeholder={c.email || "Email"}
                                onChange={(e) => setCEmail(e.target.value)}
                                style={{ maxWidth: 230 }}
                              />
                              <button
                                className="secondary"
                                disabled={busy || (!cPhone.trim() && !cEmail.trim())}
                                onClick={() => void saveContact(c.id)}
                              >
                                Save
                              </button>
                              <span className="muted" style={{ fontSize: "0.8rem" }}>
                                Blank leaves what&apos;s there alone.
                              </span>
                            </div>

                            {/* ---------------- memberships */}
                            {memberships.length > 0 && (
                              <p style={{ margin: "4px 0 10px" }}>
                                {memberships.map((m) => (
                                  <span key={m.id} className="pill" style={{ marginRight: 6 }}>
                                    {m.planName} · {m.status}
                                    {m.status === "active"
                                      ? ` · ${m.visitsCompleted}/${m.visitsPerYear} visits · renews ${m.periodEnd}`
                                      : ""}
                                  </span>
                                ))}
                                <Link href="/memberships" className="muted" style={{ fontSize: "0.85rem" }}>
                                  manage
                                </Link>
                              </p>
                            )}

                            {/* ---------------- equipment */}
                            <strong>Equipment</strong>
                            {units.length === 0 ? (
                              <p className="muted" style={{ margin: "4px 0" }}>
                                No units on record yet — add the first below.
                                The unit is the memory of the relationship:
                                visit two starts where visit one left off.
                              </p>
                            ) : (
                              units.map((u) => (
                                <div key={u.id} className="row" style={{ padding: "4px 0", alignItems: "center" }}>
                                  <span className="grow">
                                    <strong>{u.label}</strong>{" "}
                                    <span className="muted">
                                      · {KINDS.find((k) => k.key === u.kind)?.label ?? u.kind}
                                      {u.make ? ` · ${u.make} ${u.model}` : ""}
                                      {u.serial ? ` · s/n ${u.serial}` : ""}
                                      {u.installedOn ? ` · installed ${u.installedOn.slice(0, 4)}` : ""}
                                    </span>
                                    {u.history.length > 0 && (
                                      <span className="muted" style={{ display: "block", fontSize: "0.85rem" }}>
                                        Last touched:{" "}
                                        <Link href={`/jobs/${u.history[0]!.jobId}`}>
                                          #{u.history[0]!.jobNo} {u.history[0]!.jobName}
                                        </Link>{" "}
                                        ({u.history[0]!.on})
                                      </span>
                                    )}
                                  </span>
                                  {!u.retired && (
                                    <button
                                      className="secondary"
                                      style={{ minHeight: 32, padding: "2px 10px" }}
                                      disabled={busy}
                                      onClick={() => void retireUnit(c.id, u.id)}
                                    >
                                      Retire
                                    </button>
                                  )}
                                </div>
                              ))
                            )}
                            <div className="row" style={{ marginTop: 8, alignItems: "end", flexWrap: "wrap" }}>
                              <div>
                                <label htmlFor={`ul-${c.id}`}>Unit</label>
                                <input
                                  id={`ul-${c.id}`}
                                  value={uLabel}
                                  onChange={(e) => setULabel(e.target.value.slice(0, 120))}
                                  placeholder="Upstairs unit"
                                  style={{ width: 150 }}
                                />
                              </div>
                              <div>
                                <label htmlFor={`uk-${c.id}`}>Type</label>
                                <select id={`uk-${c.id}`} value={uKind} onChange={(e) => setUKind(e.target.value)}>
                                  {KINDS.map((k) => (
                                    <option key={k.key} value={k.key}>{k.label}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label htmlFor={`um-${c.id}`}>Make</label>
                                <input id={`um-${c.id}`} value={uMake} onChange={(e) => setUMake(e.target.value.slice(0, 80))} placeholder="Goodman" style={{ width: 110 }} />
                              </div>
                              <div>
                                <label htmlFor={`umo-${c.id}`}>Model</label>
                                <input id={`umo-${c.id}`} value={uModel} onChange={(e) => setUModel(e.target.value.slice(0, 120))} placeholder="GSX140361" style={{ width: 130 }} />
                              </div>
                              <div>
                                <label htmlFor={`us-${c.id}`}>Serial</label>
                                <input id={`us-${c.id}`} value={uSerial} onChange={(e) => setUSerial(e.target.value.slice(0, 120))} placeholder="2019xxxxx" style={{ width: 120 }} />
                              </div>
                              <button
                                disabled={busy || !uLabel.trim()}
                                onClick={() => void addUnit(c.id)}
                              >
                                Add unit
                              </button>
                              {!uLabel.trim() && (
                                <span className="muted" style={{ fontSize: "0.85rem" }}>
                                  Needs a name — &ldquo;Upstairs unit&rdquo; works fine
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div role="status" aria-live="polite">
        {note && <p className="muted" style={{ wordBreak: "break-all" }}>{note}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </AppShell>
  );
}
