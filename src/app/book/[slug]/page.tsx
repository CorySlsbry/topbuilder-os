"use client";
import { use, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { Skel, SkeletonRegion } from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

/**
 * The public booking page. A stranger, a phone, one bar of signal.
 *
 * No AppShell, no account, no cookie — `<main className="shell">` like the
 * customer portal. It is hosted HERE rather than embedded on the shop's own
 * marketing site on purpose: the CSRF guard in proxy.ts is fail-closed, so a
 * cross-origin POST is refused, and the right answer is to move the entry
 * point rather than weaken the guard. That is already a house rule — it is how
 * /demo was solved.
 *
 * Exactly ONE network read, on mount. Choosing a day and a window needs no
 * server round trip, which is what makes the middle of the flow feel instant
 * on a bad connection.
 */

interface Window {
  key: "am" | "pm";
  label: string;
  startsAt: string;
  endsAt: string;
}
interface Day {
  date: string;
  windows: Window[];
}
interface Availability {
  businessName: string;
  enabled: boolean;
  intro: string;
  timezone?: string;
  days: Day[];
}

function dayLabel(iso: string): string {
  // Parsed as UTC and read back in UTC on purpose: `iso` is already the
  // SHOP'S local calendar date, so re-interpreting it in the visitor's zone
  // would shift it by a day for anyone east or west of them.
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [avail, setAvail] = useState<Availability | null>(null);
  const [step, setStep] = useState<"day" | "slot" | "details" | "done">("day");
  const [day, setDay] = useState<Day | null>(null);
  const [win, setWin] = useState<Window | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [nonce] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [jobNo, setJobNo] = useState<number | null>(null);
  const showSkeleton = useFirstLoad(avail !== null, { delayMs: 180 });

  const load = useCallback(async () => {
    try {
      setAvail(await api<Availability>(`/api/public/book/${slug}`));
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? "We couldn't find that business."
          : "We couldn't load the calendar just now.",
      );
      setAvail({ businessName: "", enabled: false, intro: "", days: [] });
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    if (!win || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ jobNo: number }>(`/api/public/book/${slug}`, {
        method: "POST",
        json: {
          name,
          phone,
          email,
          address,
          description,
          website,
          nonce, // stable across retries: a double-tap books once
          startsAt: win.startsAt,
          endsAt: win.endsAt,
        },
      });
      setJobNo(r.jobNo ?? null);
      setStep("done");
    } catch (e) {
      if (e instanceof ApiError && e.code === "slot_taken") {
        // Somebody else got it between the page loading and this tap. Say so
        // plainly and put them back on a calendar that is current.
        setError("Somebody just took that time. Here's what's still open.");
        setStep("day");
        setWin(null);
        setDay(null);
        await load();
      } else if (e instanceof ApiError && e.code === "slot_too_soon") {
        setError("That time is too soon to book online — give us a call and we'll sort it out.");
        setStep("day");
        await load();
      } else {
        setError("That didn't go through. Try again, or give us a call.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (!avail) {
    return (
      <main className="shell">
        {showSkeleton && (
          <SkeletonRegion label="Loading the calendar…">
            <Skel h={30} w="58%" />
            <div className="row" style={{ marginTop: 18, gap: 8 }}>
              {Array.from({ length: 5 }, (_, i) => (
                <Skel key={i} h={44} w={92} r={999} />
              ))}
            </div>
          </SkeletonRegion>
        )}
      </main>
    );
  }

  if (!avail.enabled) {
    return (
      <main className="shell">
        <h1>{avail.businessName || "Book a visit"}</h1>
        <div className="card">
          <p style={{ margin: 0 }}>
            {error || "This shop isn't taking online bookings right now — give them a call and they'll get you on the schedule."}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <h1>{avail.businessName}</h1>
      {avail.intro && <p className="muted">{avail.intro}</p>}

      {step === "done" ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>You&apos;re on the schedule ✅</h2>
          <p>
            {day && win ? `${dayLabel(day.date)}, ${win.label}.` : ""} We&apos;ll text
            you to confirm, and again when someone is on the way.
          </p>
          {jobNo !== null && <p className="muted">Your job number is #{jobNo}.</p>}
        </div>
      ) : (
        <>
          {/* ── pick a day ─────────────────────────────────────────── */}
          <div className="card">
            <h2 style={{ marginTop: 0 }}>1. Pick a day</h2>
            {avail.days.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Nothing open online in the next couple of weeks. Give us a call
                — we can usually find something.
              </p>
            ) : (
              <div className="row">
                {avail.days.map((d) => (
                  <button
                    key={d.date}
                    className="chip"
                    aria-pressed={day?.date === d.date}
                    onClick={() => {
                      setDay(d);
                      setWin(null);
                      setStep("slot");
                    }}
                  >
                    {dayLabel(d.date)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── pick a window ──────────────────────────────────────── */}
          {day && (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>2. Pick a time</h2>
              <div className="row">
                {day.windows.map((w) => (
                  <button
                    key={w.key}
                    className="chip"
                    aria-pressed={win?.key === w.key}
                    onClick={() => {
                      setWin(w);
                      setStep("details");
                    }}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
              <p className="muted" style={{ marginBottom: 0 }}>
                We give you a half-day window, not a promise we&apos;ll be there
                at 8:00 sharp — and we text when the tech is actually on the way.
              </p>
            </div>
          )}

          {/* ── details ────────────────────────────────────────────── */}
          {win && (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>3. Where and who</h2>
              <div className="row">
                <label htmlFor="bk-name" className="sr-only">Your name</label>
                <input id="bk-name" placeholder="Your name" value={name}
                       onChange={(e) => setName(e.target.value)} style={{ minWidth: 200 }} />
                <label htmlFor="bk-phone" className="sr-only">Phone</label>
                <input id="bk-phone" placeholder="Phone" value={phone} inputMode="tel"
                       onChange={(e) => setPhone(e.target.value)} style={{ minWidth: 170 }} />
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <label htmlFor="bk-addr" className="sr-only">Address</label>
                <input id="bk-addr" placeholder="Address" value={address}
                       onChange={(e) => setAddress(e.target.value)} style={{ minWidth: 260 }} />
                <label htmlFor="bk-email" className="sr-only">Email (optional)</label>
                <input id="bk-email" placeholder="Email (optional)" value={email} inputMode="email"
                       onChange={(e) => setEmail(e.target.value)} style={{ minWidth: 220 }} />
              </div>
              <label htmlFor="bk-desc" className="sr-only">What&apos;s going on?</label>
              <textarea id="bk-desc" rows={3} placeholder="What's going on? (optional)"
                        value={description} onChange={(e) => setDescription(e.target.value)}
                        style={{ width: "100%", marginTop: 10 }} />
              {/* Honeypot — off-screen, never announced, never tabbable. */}
              <input className="sr-only" tabIndex={-1} autoComplete="off" aria-hidden="true"
                     value={website} onChange={(e) => setWebsite(e.target.value)} />
              <div className="row" style={{ marginTop: 12 }}>
                <button disabled={busy || !name.trim()} onClick={() => void submit()}>
                  {busy ? "Booking…" : `Book ${dayLabel(day!.date)}, ${win.label}`}
                </button>
                <button className="secondary" disabled={busy} onClick={() => { setWin(null); setStep("slot"); }}>
                  Change time
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <div role="status" aria-live="polite">
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}
