"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Member {
  userId: string;
  role: string;
  departments: string[];
  isYou: boolean;
}
interface Dept {
  key: string;
  name: string;
}
interface Booking {
  enabled: boolean;
  daysOut: number;
  minLeadHours: number;
  intro: string;
  slug: string;
  timezone: string;
}
interface FormGate {
  gateCompletion: boolean;
}
interface JobVisibility {
  crewSeesProfit: boolean;
}
interface Comms {
  smsNumber: string;
  smsStatus: "none" | "pending_a2p" | "active";
  reminderEnabled: boolean;
  onMyWayEnabled: boolean;
  receiptEnabled: boolean;
  visitDueEnabled: boolean;
  googleReviewUrl: string;
}

const ROLE_WORDS: Record<string, string> = {
  owner: "Owner — everything, always",
  admin: "Admin — everything, always",
  staff: "Staff — only what's switched on below",
  bookkeeper: "Bookkeeper — your CPA / books person",
  viewer: "Viewer — look, don't touch",
};

/** The built-in keys that gate screens; renameable, never deletable. */
const STANDARD_KEYS = new Set(["field", "financials", "hr"]);

/** "Install Crews" → "install-crews", matching the server's key rule. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 30);
}

export default function TeamPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [departments, setDepartments] = useState<Dept[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [newDept, setNewDept] = useState("");
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [comms, setComms] = useState<Comms | null>(null);
  const [reviewUrl, setReviewUrl] = useState("");
  const [booking, setBooking] = useState<Booking | null>(null);
  const [visibility, setVisibility] = useState<JobVisibility | null>(null);
  const [formGate, setFormGate] = useState<FormGate | null>(null);
  const [tz, setTz] = useState("");
  const [intro, setIntro] = useState("");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      const r = await api<{ members: Member[]; departments: Dept[] }>("/api/team");
      setMembers(r.members);
      setDepartments(r.departments);
      const cs = await api<Comms>("/api/comms/settings").catch(() => null);
      if (cs) {
        setComms(cs);
        setReviewUrl(cs.googleReviewUrl);
      }
      setVisibility(
        await api<JobVisibility>("/api/settings/job-visibility").catch(() => null),
      );
      setFormGate(await api<FormGate>("/api/settings/job-forms").catch(() => null));
      const bk = await api<Booking>("/api/booking/settings").catch(() => null);
      if (bk) {
        setBooking(bk);
        setTz(bk.timezone);
        setIntro(bk.intro);
      }
        setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load the team.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(m: Member, deptKey: string) {
    const next = m.departments.includes(deptKey)
      ? m.departments.filter((d) => d !== deptKey)
      : [...m.departments, deptKey];
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api("/api/team", {
        method: "POST",
        json: { action: "set-departments", userId: m.userId, departments: next },
      });
      setNote("Saved — takes effect on their very next click.");
    } catch {
      setError("Couldn't save that — try again.");
    } finally {
      setBusy(false);
      await load();
    }
  }

  async function setRole(m: Member, role: string) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api("/api/team", {
        method: "POST",
        json: { action: "set-role", userId: m.userId, role },
      });
      setNote("Role updated.");
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "last_owner"
          ? "That's the only owner — hand ownership to someone else first."
          : e instanceof ApiError && e.status === 403
            ? "Only the owner can change roles."
            : "Couldn't change the role.",
      );
    } finally {
      setBusy(false);
      await load();
    }
  }

  const adminLike = (r: string) => r === "owner" || r === "admin";

  /** One wrapper so every department action shares busy/note/error handling. */
  async function deptAction(json: Record<string, unknown>, okNote: string) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api("/api/team", { method: "POST", json });
      setNote(okNote);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "department_exists"
          ? "There's already a department with that name."
          : e instanceof ApiError && e.code === "department_in_use"
            ? "Remove it from everyone first — deleting won't strip access silently."
            : e instanceof ApiError && e.code === "department_protected"
              ? "That one's built in — it controls screens, so it can be renamed but not deleted."
              : e instanceof ApiError && e.code === "aal2_required"
                ? (e.message as string)
                : "Couldn't save that — try again.",
      );
    } finally {
      setBusy(false);
      await load();
    }
  }

  async function addDept() {
    const key = slugify(newDept);
    if (!key || key.length < 2) {
      setError("Give the department a name with at least a couple of letters.");
      return;
    }
    await deptAction(
      { action: "create-department", key, name: newDept.trim() },
      "Added — now switch it on for the right people above.",
    );
    setNewDept("");
  }

  /**
   * The mutation wrapper for the settings blocks below.
   *
   * The rest of this page inlines the same try/catch/finally at every call
   * site, which is fine for two of them and noise for eight. This does not
   * refetch: each of these calls returns the settings row it just wrote, so
   * `load()` would be a second round trip for data already in hand.
   */
  async function save(fn: () => Promise<void>, ok: string) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await fn();
      setNote(ok);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "unknown_timezone"
          ? "That isn't a timezone we recognise — try something like America/Phoenix."
          : "Couldn't save that.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveRename(key: string) {
    await deptAction(
      { action: "rename-department", key, name: renameVal.trim() },
      "Renamed.",
    );
    setRenameKey(null);
  }

  async function removeDept(key: string) {
    await deptAction({ action: "delete-department", key }, "Deleted.");
  }

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Team & access">
        {showSkeleton && <PageSkeleton kind="list" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Team & access">
      <div className="card">
        <p style={{ marginTop: 0 }}>
          Who can see what. <strong>Owners and admins always see everything.</strong>{" "}
          Everyone else sees only the areas you switch on — so the crew never
          opens the books, and the books person never touches pay rates unless
          you say so. Works the same whether you have one person or ten.
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          Hiding a menu is the polite part; the server refuses the data either
          way. Every switch takes effect on the person&apos;s next click.
        </p>
      </div>

      {members.map((m) => (
        <div key={m.userId} className="card">
          <div className="row" style={{ marginBottom: adminLike(m.role) ? 0 : 10 }}>
            <div className="grow">
              <strong>{m.userId.replace(/^dev:/, "")}</strong>{" "}
              {m.isYou && <span className="pill">you</span>}
              <div className="muted">{ROLE_WORDS[m.role] ?? m.role}</div>
            </div>
            <select
              aria-label={`Role for ${m.userId}`}
              value={m.role}
              disabled={busy || m.isYou}
              style={{ width: 150 }}
              onChange={(e) => void setRole(m, e.target.value)}
            >
              {Object.keys(ROLE_WORDS).map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          {!adminLike(m.role) && (
            <div className="row" role="group" aria-label={`Access for ${m.userId}`}>
              {departments.map((d) => {
                const on = m.departments.includes(d.key);
                return (
                  <button
                    key={d.key}
                    className="chip"
                    aria-pressed={on}
                    disabled={busy}
                    onClick={() => void toggle(m, d.key)}
                  >
                    {on ? "✓" : "+"} {d.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}

      {/* ---------------------------------------------- department manager */}
      <h2>Departments</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Make this match how <em>your</em> company actually runs — install
          crews, service, sales, warehouse, whatever you call them. Give anyone
          any mix. The first three are built-in:{" "}
          <strong>Money &amp; books</strong>, <strong>People &amp; pay</strong>{" "}
          and <strong>Field &amp; jobs</strong> control which screens a person
          can open, so they can be renamed but never deleted.
        </p>

        {departments.map((d) => {
          const isStandard = STANDARD_KEYS.has(d.key);
          const granted = members.filter((m) => m.departments.includes(d.key)).length;
          return (
            <div key={d.key} className="row" style={{ padding: "6px 0", alignItems: "center" }}>
              {renameKey === d.key ? (
                <>
                  <input
                    aria-label={`New name for ${d.name}`}
                    value={renameVal}
                    onChange={(e) => setRenameVal(e.target.value.slice(0, 60))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveRename(d.key);
                      if (e.key === "Escape") setRenameKey(null);
                    }}
                    autoFocus
                    style={{ maxWidth: 240 }}
                  />
                  <button
                    className="secondary"
                    style={{ minHeight: 34, padding: "4px 12px" }}
                    disabled={busy || !renameVal.trim()}
                    onClick={() => void saveRename(d.key)}
                  >
                    Save
                  </button>
                  <button
                    className="secondary"
                    style={{ minHeight: 34, padding: "4px 12px" }}
                    onClick={() => setRenameKey(null)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className="grow">
                    <strong>{d.name}</strong>{" "}
                    <span className="muted">
                      · {granted} {granted === 1 ? "person" : "people"}
                      {isStandard ? " · controls screens" : ""}
                    </span>
                  </span>
                  <button
                    className="secondary"
                    style={{ minHeight: 34, padding: "4px 12px" }}
                    disabled={busy}
                    onClick={() => {
                      setRenameKey(d.key);
                      setRenameVal(d.name);
                    }}
                  >
                    Rename
                  </button>
                  {!isStandard && (
                    <button
                      className="secondary"
                      style={{ minHeight: 34, padding: "4px 12px" }}
                      disabled={busy || granted > 0}
                      title={
                        granted > 0
                          ? "Remove it from everyone first — deleting won't strip access silently"
                          : undefined
                      }
                      onClick={() => void removeDept(d.key)}
                    >
                      Delete
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}

        <div className="row" style={{ marginTop: 12, alignItems: "end" }}>
          <div className="grow">
            <label htmlFor="new-dept">Add a department</label>
            <input
              id="new-dept"
              value={newDept}
              onChange={(e) => setNewDept(e.target.value.slice(0, 60))}
              placeholder="Install crews"
              onKeyDown={(e) => {
                if (e.key === "Enter") void addDept();
              }}
            />
          </div>
          <button disabled={busy || !newDept.trim()} onClick={() => void addDept()}>
            Add
          </button>
        </div>
        {newDept.trim() && (
          <p className="muted" style={{ marginBottom: 0, fontSize: "0.85rem" }}>
            Will be created as <code>{slugify(newDept)}</code> — you can then
            switch it on for anyone above.
          </p>
        )}
      </div>

      {/* ------------------------------------ finishing a job needs its forms */}
      {formGate && (
        <>
          <h2>Finishing a job</h2>
          <div className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              With this on, a job can&apos;t be marked complete or closed until every
              form you marked <strong>required</strong> is finished. Forms you
              didn&apos;t mark required never block anything.
            </p>
            <p className="muted">
              Moving a job BACKWARDS is never blocked — somebody can always undo a
              mistake. And this only does something once you have required forms
              set up under Forms, so switching it on early is harmless.
            </p>

            <div className="row">
              <button
                className={formGate.gateCompletion ? undefined : "secondary"}
                aria-pressed={formGate.gateCompletion}
                disabled={busy}
                onClick={() =>
                  void save(async () => {
                    setFormGate(
                      await api<FormGate>("/api/settings/job-forms", {
                        method: "PATCH",
                        json: { gateCompletion: !formGate.gateCompletion },
                      }),
                    );
                  }, formGate.gateCompletion
                    ? "Jobs can be finished without their forms again."
                    : "Required forms now have to be finished first.")
                }
              >
                {formGate.gateCompletion
                  ? "✓ Required forms must be finished first"
                  : "Forms don't block finishing a job"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* --------------------------------------- what the crew can see */}
      {visibility && (
        <>
          <h2>What the crew can see</h2>
          <div className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              Show your crew what a job has made: billed minus everything it
              cost, on the job screen. They never see your estimate-to-finish,
              your over/under billing, or the cost breakdown by code — only the
              one number, and only if you switch it on here.
            </p>
            <p className="muted">
              <strong>Think about it before you do.</strong> On a two- or
              three-person job, labor cost divided by the hours on that job is
              close enough to somebody&apos;s pay rate that a crew member with a
              phone calculator can work out what the other guy makes. Plenty of
              shops want this on anyway — it is the fastest way to get a crew
              caring about waste. It is your call, not ours, which is why it
              ships off.
            </p>

            <div className="row">
              <button
                className={visibility.crewSeesProfit ? undefined : "secondary"}
                aria-pressed={visibility.crewSeesProfit}
                disabled={busy}
                onClick={() =>
                  void save(async () => {
                    setVisibility(
                      await api<JobVisibility>("/api/settings/job-visibility", {
                        method: "PATCH",
                        json: { crewSeesProfit: !visibility.crewSeesProfit },
                      }),
                    );
                  }, visibility.crewSeesProfit
                    ? "The crew can no longer see job profit."
                    : "The crew can now see job profit.")
                }
              >
                {visibility.crewSeesProfit ? "✓ Crew sees job profit" : "Crew does not see job profit"}
              </button>
            </div>
            <p className="muted" style={{ marginBottom: 0, fontSize: "0.85rem" }}>
              Changing this needs your second factor — it is a pay-information
              decision, so it sits with the other step-up settings rather than
              the everyday ones.
            </p>
          </div>
        </>
      )}

      {/* ------------------------------------------------ online booking */}
      {booking && (
        <>
          <h2>Online booking</h2>
          <div className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              A page where a customer picks their own half-day and it lands on
              your board — against real capacity, so it can never promise a
              time your crew can&apos;t make. Off until you turn it on.
            </p>

            <div className="row">
              <button
                className={booking.enabled ? undefined : "secondary"}
                aria-pressed={booking.enabled}
                disabled={busy}
                onClick={() =>
                  void save(async () => {
                    setBooking(
                      await api<Booking>("/api/booking/settings", {
                        method: "PATCH",
                        json: { enabled: !booking.enabled },
                      }),
                    );
                  }, booking.enabled ? "Online booking is off." : "Online booking is on.")
                }
              >
                {booking.enabled ? "✓ On" : "Off"}
              </button>
              {booking.enabled && booking.slug && (
                <button
                  className="secondary"
                  onClick={() => {
                    const url = `${window.location.origin}/book/${booking.slug}`;
                    void navigator.clipboard.writeText(url).catch(() => {});
                    setNote(`Copied — put this on your website: ${url}`);
                  }}
                >
                  🔗 Copy your booking link
                </button>
              )}
            </div>

            {/* The clock everything is scheduled in. Wrong here means every
                window a customer sees is the wrong hour — it was UTC for
                everyone until migration 0042. */}
            <div className="row" style={{ marginTop: 12 }}>
              <label htmlFor="tz">Your timezone</label>
              <input
                id="tz"
                value={tz}
                onChange={(e) => setTz(e.target.value)}
                placeholder="America/Phoenix"
                style={{ minWidth: 220 }}
              />
              <button
                className="secondary"
                disabled={busy || !tz.trim() || tz === booking.timezone}
                onClick={() =>
                  void save(async () => {
                    setBooking(
                      await api<Booking>("/api/booking/settings", {
                        method: "PATCH",
                        json: { timezone: tz.trim() },
                      }),
                    );
                  }, "Saved — appointment times now use your clock.")
                }
              >
                Save timezone
              </button>
            </div>

            <div className="row" style={{ marginTop: 12 }}>
              <label htmlFor="lead">Notice you need</label>
              <select
                id="lead"
                value={booking.minLeadHours}
                disabled={busy}
                onChange={(e) =>
                  void save(async () => {
                    setBooking(
                      await api<Booking>("/api/booking/settings", {
                        method: "PATCH",
                        json: { minLeadHours: Number(e.target.value) },
                      }),
                    );
                  }, "Saved.")
                }
              >
                <option value={0}>No minimum</option>
                <option value={4}>4 hours</option>
                <option value={12}>Half a day</option>
                <option value={24}>A full day</option>
                <option value={48}>Two days</option>
              </select>
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                Windows starting sooner than this aren&apos;t offered online.
              </span>
            </div>

            <div className="row" style={{ marginTop: 12 }}>
              <label htmlFor="intro" className="sr-only">What the page says</label>
              <input
                id="intro"
                value={intro}
                onChange={(e) => setIntro(e.target.value)}
                placeholder="A line in your own words, shown at the top of the page"
                style={{ flex: 1, minWidth: 260 }}
              />
              <button
                className="secondary"
                disabled={busy || intro === booking.intro}
                onClick={() =>
                  void save(async () => {
                    setBooking(
                      await api<Booking>("/api/booking/settings", {
                        method: "PATCH",
                        json: { intro: intro.trim() },
                      }),
                    );
                  }, "Saved.")
                }
              >
                Save
              </button>
            </div>
          </div>
        </>
      )}

      {/* ------------------------------------------- customer messages */}
      {comms && (
        <>
          <h2>Customer messages</h2>
          <div className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              The texts and emails that go out on their own — reminders,
              &ldquo;tech on the way&rdquo;, receipts, tune-up nudges. Review
              asks and payment chasing always wait for your approval under
              Helpers; these are the routine ones customers expect instantly.
            </p>
            <p style={{ marginTop: 0 }}>
              {comms.smsStatus === "active" ? (
                <>Texts send from <strong>{comms.smsNumber}</strong> — your shop&apos;s own number.</>
              ) : comms.smsStatus === "pending_a2p" ? (
                <>Your text number is registering with the carriers (takes a few
                days) — messages go by <strong>email</strong> until it clears.</>
              ) : (
                <>No text number yet — messages go by <strong>email</strong>.
                We&apos;ll set up your shop&apos;s own number when you&apos;re ready.</>
              )}
            </p>
            {(
              [
                ["reminderEnabled", "Appointment reminder, the day before"],
                ["onMyWayEnabled", "“Tech on the way” when they tap the button"],
                ["receiptEnabled", "Payment receipt"],
                ["visitDueEnabled", "Membership tune-up due"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="row" style={{ padding: "3px 0", alignItems: "center" }}>
                <span className="grow">{label}</span>
                <button
                  className="chip"
                  aria-pressed={comms[key]}
                  disabled={busy}
                  onClick={() =>
                    void (async () => {
                      setBusy(true);
                      try {
                        const next = await api<Comms>("/api/comms/settings", {
                          method: "PATCH",
                          json: { [key]: !comms[key] },
                        });
                        setComms(next);
                      } catch {
                        setError("Couldn't save that toggle.");
                      } finally {
                        setBusy(false);
                      }
                    })()
                  }
                >
                  {comms[key] ? "✓ On" : "Off"}
                </button>
              </div>
            ))}
            <div className="row" style={{ marginTop: 10, alignItems: "end" }}>
              <div className="grow">
                <label htmlFor="review-url">Google review link (for review asks)</label>
                <input
                  id="review-url"
                  value={reviewUrl}
                  onChange={(e) => setReviewUrl(e.target.value.slice(0, 300))}
                  placeholder="https://g.page/r/…/review"
                />
              </div>
              <button
                className="secondary"
                disabled={busy || reviewUrl === comms.googleReviewUrl}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      const next = await api<Comms>("/api/comms/settings", {
                        method: "PATCH",
                        json: { googleReviewUrl: reviewUrl.trim() },
                      });
                      setComms(next);
                      setNote("Saved.");
                    } catch {
                      setError("Couldn't save the link.");
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                Save
              </button>
            </div>
          </div>
        </>
      )}

      <div role="status" aria-live="polite">
        {note && <p className="muted">{note}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </AppShell>
  );
}
