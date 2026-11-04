"use client";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { loadStripe, type Stripe, type StripeElements } from "@stripe/stripe-js";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Portal {
  businessName: string;
  customerName: string;
  jobs: { id: string; jobNo: number; name: string; status: string }[];
  invoices: {
    id: string;
    invoiceNo: number;
    issuedOn: string;
    totalCents: number;
    openCents: number;
    status: string;
  }[];
  estimates: {
    id: string;
    jobName: string;
    status: string;
    options: { id: string; label: string; totalCents: number }[];
  }[];
  changeOrders: {
    id: string;
    coNo: number;
    jobName: string;
    title: string;
    reason: string;
    totalCents: number;
    lines: { description: string; lineTotalCents: number }[];
  }[];
}

const STATUS_WORDS: Record<string, string> = {
  lead: "Getting a quote together",
  scheduled: "On the schedule",
  "in-progress": "Crew is working",
  completed: "Work finished",
  closed: "All wrapped up",
};

export default function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<Portal | null>(null);
  // First paint only — the latch means a save never re-flashes the screen.
  const showPortalSkeleton = useFirstLoad(data !== null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  // Card-on-file: the Stripe element lives in the customer's browser and
  // talks straight to Stripe — the card number never touches the contractor
  // or this server. We only ever learn "Visa ending 4242".
  const [cardOpen, setCardOpen] = useState(false);
  const [cardBusy, setCardBusy] = useState(false);
  const [savedCard, setSavedCard] = useState("");
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Portal>(`/api/public/portal/${token}`));
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? "This link isn't active anymore — ask your contractor for a fresh one."
          : "Couldn't load your page — try again in a minute.",
      );
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Returning from a bank-verification redirect (rare for cards, but the
  // element may bounce through one): finish saving with the id in the URL.
  useEffect(() => {
    const url = new URL(window.location.href);
    const si = url.searchParams.get("setup_intent");
    if (!si) return;
    url.searchParams.delete("setup_intent");
    url.searchParams.delete("setup_intent_client_secret");
    url.searchParams.delete("redirect_status");
    window.history.replaceState(null, "", url.toString());
    void (async () => {
      try {
        const saved = await api<{ brand: string; last4: string }>(
          `/api/public/portal/${token}/card`,
          { method: "POST", json: { action: "confirm", setupIntentId: si } },
        );
        setSavedCard(`${saved.brand || "Card"} ending ${saved.last4}`);
        setNote("Card saved — your plan renews on its own now.");
      } catch {
        setError("Couldn't finish saving the card — try again.");
      }
    })();
  }, [token]);

  async function startCardSave() {
    setCardBusy(true);
    setError("");
    try {
      const r = await api<{ clientSecret: string; publishableKey: string | null }>(
        `/api/public/portal/${token}/card`,
        { method: "POST", json: { action: "start" } },
      );
      if (!r.publishableKey) throw new ApiError(503, "payments_not_configured");
      const stripe = await loadStripe(r.publishableKey);
      if (!stripe) throw new Error("stripe failed to load");
      stripeRef.current = stripe;
      const elements = stripe.elements({ clientSecret: r.clientSecret });
      elementsRef.current = elements;
      setCardOpen(true);
      // Mount after the container renders.
      setTimeout(() => {
        elements.create("payment").mount("#card-element");
      }, 0);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "payments_not_configured"
          ? "Card saving isn't switched on yet — call or text us instead."
          : "Couldn't start — try again in a minute.",
      );
    } finally {
      setCardBusy(false);
    }
  }

  async function confirmCardSave() {
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    if (!stripe || !elements) return;
    setCardBusy(true);
    setError("");
    const result = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: "if_required",
    });
    if (result.error) {
      setError(result.error.message ?? "The card didn't go through — check it and try again.");
      setCardBusy(false);
      return;
    }
    try {
      const saved = await api<{ brand: string; last4: string }>(
        `/api/public/portal/${token}/card`,
        { method: "POST", json: { action: "confirm", setupIntentId: result.setupIntent.id } },
      );
      setSavedCard(`${saved.brand || "Card"} ending ${saved.last4}`);
      setCardOpen(false);
      setNote("Card saved — your plan renews on its own now.");
    } catch {
      setError("Stripe saved the card but we couldn't record it — call us and we'll sort it.");
    } finally {
      setCardBusy(false);
    }
  }

  async function payNow(invoiceId: string) {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ url: string }>(`/api/public/portal/${token}/checkout`, {
        method: "POST",
        json: { invoiceId },
      });
      window.location.href = r.url;
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "payments_not_configured"
          ? "Card payment is almost ready — for now, call or text us and we'll take it by check or over the phone."
          : "That didn't go through — try again or give us a call.",
      );
      setBusy(false);
    }
  }

  async function approve(estimateId: string, optionId: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/public/portal/${token}`, { method: "POST", json: { estimateId, optionId } });
      setNote("Approved! Your contractor has been notified and will get you on the schedule.");
      await load();
    } catch {
      setError("That didn't go through — try again or give us a call.");
    } finally {
      setBusy(false);
    }
  }

  async function approveChangeOrder(changeOrderId: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/public/portal/${token}`, {
        method: "POST",
        json: { action: "approve-change-order", changeOrderId },
      });
      setNote("Approved — thanks. Your contractor has it, and it's on your job now.");
      await load();
    } catch {
      setError("That didn't go through — try again or give us a call.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <main className="shell">
        <h1>Hmm.</h1>
        <p>{error}</p>
      </main>
    );
  }
  // Was: an EMPTY <main>. A customer who clicked a link from their
  // contractor got a white rectangle while the token resolved — the worst
  // possible first impression, on the one page we do not control the
  // network conditions for.
  if (!data) {
    return (
      <main className="shell">
        {showPortalSkeleton && <PageSkeleton kind="detail" />}
      </main>
    );
  }

  const openTotal = data.invoices.reduce((t, i) => t + i.openCents, 0);

  return (
    <main className="shell">
      <h1>{data.businessName}</h1>
      <p className="muted">
        Hi {data.customerName.split(" ")[0]} — here&apos;s where everything
        stands. No login, no password; keep this link private.
      </p>

      {data.estimates.filter((e) => e.status === "draft").length > 0 && (
        <>
          <h2>Waiting on your OK</h2>
          {data.estimates
            .filter((e) => e.status === "draft")
            .map((e) => (
              <div key={e.id} className="card">
                <p style={{ marginTop: 0 }}>
                  <strong>{e.jobName}</strong> — pick the option that fits:
                </p>
                <div className="row">
                  {e.options.map((o) => (
                    <button key={o.id} disabled={busy} onClick={() => void approve(e.id, o.id)}>
                      {o.label} — {dollars(o.totalCents)}
                    </button>
                  ))}
                </div>
                <p className="muted" style={{ marginBottom: 0 }}>
                  One tap approves it — nothing is charged today.
                </p>
              </div>
            ))}
        </>
      )}

      {data.changeOrders.length > 0 && (
        <>
          <h2>A change to your job</h2>
          {data.changeOrders.map((co) => (
            <div key={co.id} className="card">
              <p style={{ marginTop: 0 }}>
                <strong>{co.jobName}</strong> — {co.title}
              </p>
              {co.reason && <p className="muted">{co.reason}</p>}
              {co.lines.map((l, i) => (
                <div key={i} className="row" style={{ padding: "2px 0" }}>
                  <span className="grow">{l.description}</span>
                  <span>{dollars(l.lineTotalCents)}</span>
                </div>
              ))}
              <p style={{ marginBottom: 8 }}>
                {/* Direction in words. Nobody should have to work out what a
                    minus sign in front of a price means about their bill. */}
                <strong>
                  {co.totalCents >= 0
                    ? `This adds ${dollars(co.totalCents)} to your job.`
                    : `This takes ${dollars(-co.totalCents)} off your job.`}
                </strong>
              </p>
              <button disabled={busy} onClick={() => void approveChangeOrder(co.id)}>
                Approve CO #{co.coNo}
              </button>
              <p className="muted" style={{ marginBottom: 0 }}>
                One tap approves it — nothing is charged today. Questions? Call
                and they&apos;ll walk you through it.
              </p>
            </div>
          ))}
        </>
      )}

      <h2>Your jobs</h2>
      <div className="card">
        {data.jobs.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nothing yet.</p>
        ) : (
          data.jobs.map((j) => (
            <p key={j.id} style={{ margin: "4px 0" }}>
              <strong>#{j.jobNo} {j.name}</strong> — {STATUS_WORDS[j.status] ?? j.status}
            </p>
          ))
        )}
      </div>

      <h2>Invoices</h2>
      <div className="card">
        {data.invoices.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No invoices yet.</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Still due</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((i) => (
                  <tr key={i.id}>
                    <td>#{i.invoiceNo}</td>
                    <td>{i.issuedOn}</td>
                    <td>{dollars(i.totalCents)}</td>
                    <td>
                      {i.openCents > 0 ? (
                        <span className="row" style={{ gap: 6 }}>
                          <strong>{dollars(i.openCents)}</strong>
                          <button
                            className="secondary"
                            style={{ minHeight: 34, padding: "4px 12px" }}
                            disabled={busy}
                            onClick={() => void payNow(i.id)}
                          >
                            Pay now
                          </button>
                        </span>
                      ) : (
                        "Paid ✓"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" style={{ marginBottom: 0 }}>
              {openTotal > 0
                ? `Balance across everything: ${dollars(openTotal)}. Pay by check or card — call or text us and we'll sort it in a minute.`
                : "You're all paid up. Thank you!"}
            </p>
          </>
        )}
      </div>

      <h2>Card on file</h2>
      <div className="card">
        {savedCard ? (
          <p style={{ margin: 0 }}>
            <strong>{savedCard}</strong> is saved for automatic payments. To
            change it, just add a new card — call or text us to remove one.
          </p>
        ) : (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              Save a card once and your maintenance plan (and anything you ask
              us to auto-pay) takes care of itself. You type the card straight
              into our card processor&apos;s secure form —{" "}
              <strong>{data.businessName} never sees the number</strong>.
            </p>
            {cardOpen && <div id="card-element" style={{ margin: "10px 0" }} />}
            {cardOpen ? (
              <button disabled={cardBusy} onClick={() => void confirmCardSave()}>
                {cardBusy ? "Saving…" : "Save this card"}
              </button>
            ) : (
              <button className="secondary" disabled={cardBusy} onClick={() => void startCardSave()}>
                {cardBusy ? "One sec…" : "Add a card"}
              </button>
            )}
          </>
        )}
      </div>

      <div role="status" aria-live="polite">
        {note && <p className="muted">{note}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}
