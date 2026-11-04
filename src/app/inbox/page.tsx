"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import { api, ApiError, newIdempotencyKey } from "@/lib/client/api";
import { SkelRows } from "@/components/Skeleton";
import PolishBox from "@/components/PolishBox";
import { hasUnfilledPlaceholders } from "@/lib/assist/placeholders";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

/**
 * The shared inbox — the screen the office lives in.
 *
 * One thread per person, every medium in it (text, call, voicemail, email,
 * internal note), and a box to answer. Two panes on a desk, one pane on a
 * phone: on a small screen the list gives way to the thread entirely, because
 * a half-width conversation on a 375px display is nobody's idea of usable.
 *
 * The polish button never replaces what you typed. It shows both, and you
 * pick. That is not politeness — it is the only honest shape for a feature
 * where a machine rewrote a message going out under a person's name.
 */

interface Thread {
  id: string;
  customerId: string | null;
  customerName: string | null;
  contactKind: "phone" | "email";
  contact: string;
  contactDisplay: string;
  contactName: string;
  status: "open" | "closed";
  assignedTo: string;
  unread: number;
  lastMessageAt: string;
  preview: string;
  previewDirection: "inbound" | "outbound" | null;
}
interface Message {
  id: string;
  direction: "inbound" | "outbound";
  channel: "sms" | "voice" | "email" | "note";
  body: string;
  subject: string;
  status: string;
  error: string;
  durationSeconds: number | null;
  authorUid: string;
  polished: boolean;
  createdAt: string;
  media: { id: string; contentType: string; bytes: number }[];
}
interface Detail extends Thread {
  messages: Message[];
  reply: { channel: "sms" | "email" | null; blocked: string };
}

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
        ", " +
        d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export default function InboxPage() {
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [filter, setFilter] = useState<"open" | "mine" | "all">("open");
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [polishOn, setPolishOn] = useState(false);
  const [draftOn, setDraftOn] = useState(false);
  const [canWrite, setCanWrite] = useState(true);
  const [me, setMe] = useState("");

  const [draft, setDraft] = useState("");
  /**
   * The exact words the helper produced and the person accepted.
   *
   * Kept ONLY to stamp `polished` on the outgoing message honestly: if they
   * edited the rewrite afterwards, the message is theirs again and must not be
   * recorded as machine-written.
   */
  const [polishedText, setPolishedText] = useState<string | null>(null);
  /** The voicemail we are drafting a reply to right now, if any. */
  const [draftingId, setDraftingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(threads !== null);
  // One key per user INTENTION: minted when a send starts, held across retries,
  // dropped only when the message actually goes. See lib/client/api.ts.
  const sendKey = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    try {
      const qs = filter === "mine" ? "?mine=1" : filter === "all" ? "?status=all" : "";
      const r = await api<{
        threads: Thread[];
        me: string;
        polish: boolean;
        draft: boolean;
        canWrite: boolean;
      }>(`/api/inbox${qs}`);
      setThreads(r.threads);
      setMe(r.me);
      setPolishOn(r.polish);
      setDraftOn(r.draft);
      setCanWrite(r.canWrite);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load the inbox.");
    }
  }, [filter, router]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Deep link from elsewhere in the app ("Message" on a customer row).
  // Read from location rather than useSearchParams: this page is entirely
  // client-rendered, and useSearchParams would drag a Suspense boundary in
  // for a query string we can read directly.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("thread");
    if (id) void open(id);
    // Intentionally mount-only: later navigation happens by clicking the list.
  }, []);

  const loadThread = useCallback(async (id: string) => {
    setError("");
    try {
      const r = await api<{ thread: Detail }>(`/api/inbox/${id}`);
      setDetail(r.thread);
    } catch {
      setError("Couldn't open that conversation.");
    }
  }, []);

  useEffect(() => {
    if (openId) void loadThread(openId);
    else setDetail(null);
  }, [openId, loadThread]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [detail?.messages.length]);

  async function open(id: string) {
    setOpenId(id);
    setDraft("");
    setPolishedText(null);
    setNote("");
    // Clear the badge locally the moment it's opened; the server already did.
    setThreads((t) => t?.map((x) => (x.id === id ? { ...x, unread: 0 } : x)) ?? null);
  }

  /**
   * Ask for a first draft of a reply to ONE voicemail.
   *
   * The message id goes over the wire, never the transcript: the server loads
   * the row itself, so a client cannot choose what the model reads. And the
   * result lands in the SAME box the person types in — there is no separate
   * "AI reply" that could be sent without being read.
   *
   * A rejected draft comes back EMPTY on purpose. Unlike polish there is no
   * original wording to fall back to, and the alternative to nothing is
   * something unverified sitting in a box addressed to a customer.
   */
  async function draftFrom(messageId: string) {
    setDraftingId(messageId);
    setError("");
    setNote("");
    try {
      const r = await api<{ draft: string; needsFilling: boolean; note: string }>(
        "/api/assist/draft",
        { method: "POST", json: { messageId } },
      );
      if (r.draft) {
        setDraft(r.draft);
        // NOT marked as polished: that flag means "these exact words came out
        // of the helper and the person sent them unchanged", and a draft is
        // meant to be edited before it goes anywhere.
        setPolishedText(null);
        setNote(
          r.needsFilling
            ? "Draft ready. Fill in the [blanks] — it can't send while any are left."
            : "Draft ready. Read it before you send it.",
        );
      } else {
        setNote(r.note || "No draft this time. Write your own reply below.");
      }
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "draft_rate_limited"
          ? "You've asked for a lot of drafts this hour — give it a few minutes."
          : "The draft helper isn't available right now.",
      );
    } finally {
      setDraftingId(null);
    }
  }

  async function send(asNote: boolean) {
    const text = draft.trim();
    if (!text || !openId) return;
    setBusy(true);
    setError("");
    setNote("");
    sendKey.current ??= newIdempotencyKey();
    try {
      const r = await api<{ status: string; error: string }>(
        `/api/inbox/${openId}/messages`,
        {
          method: "POST",
          idempotencyKey: sendKey.current,
          json: {
            body: text,
            channel: asNote ? "note" : "auto",
            // Only true when these exact words came out of the helper.
            polished: !asNote && polishedText === text,
          },
        },
      );
      sendKey.current = null;
      setDraft("");
      setPolishedText(null);
      setNote(
        asNote
          ? "Note saved — nobody outside the shop sees it."
          : r.status === "failed"
            ? `It didn't go through: ${r.error || "the carrier refused it"}. It's on the thread so you know.`
            : "Sent.",
      );
      await Promise.all([loadThread(openId), loadList()]);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "no_delivery_channel"
          ? "There's no way to reach this person yet — add an email, or finish setting up your text number under Team."
          : e instanceof ApiError
            ? e.message
            : "That didn't send — try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: "open" | "closed") {
    if (!openId) return;
    setBusy(true);
    try {
      await api(`/api/inbox/${openId}`, {
        method: "PATCH",
        json: { action: "update", status },
      });
      setNote(status === "closed" ? "Marked done." : "Reopened.");
      await Promise.all([loadThread(openId), loadList()]);
    } catch {
      setError("Couldn't update that.");
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    if (!openId) return;
    setBusy(true);
    try {
      await api(`/api/inbox/${openId}`, {
        method: "PATCH",
        json: { action: "update", assignedTo: detail?.assignedTo === me ? "" : me },
      });
      await Promise.all([loadThread(openId), loadList()]);
    } catch {
      setError("Couldn't update that.");
    } finally {
      setBusy(false);
    }
  }

  async function makeCustomer() {
    if (!openId) return;
    setBusy(true);
    setError("");
    try {
      await api<{ customerId: string }>(`/api/inbox/${openId}`, {
        method: "PATCH",
        json: {
          action: "link-customer",
          newName: detail?.contactName || detail?.contactDisplay,
        },
      });
      setNote("Saved as a customer — their jobs and invoices hang off this now.");
      await Promise.all([loadThread(openId), loadList()]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save that customer.");
    } finally {
      setBusy(false);
    }
  }

  const title = (t: Thread) =>
    t.customerName || t.contactName || t.contactDisplay;

  /**
   * A draft with blanks left in it cannot be sent.
   *
   * The same check runs in sendReply() on the server - this one only explains
   * WHY the button is off. A gate that lives solely in a browser is a
   * suggestion, and this one stands between a customer and a text that reads
   * "I can be there [time] on [date]".
   */
  const draftHasBlanks = hasUnfilledPlaceholders(draft);

  return (
    <AppShell title="Inbox">
      <div className={`inbox ${openId ? "inbox--open" : ""}`}>
        {/* ─────────────────────────────── the list ─────────────────────── */}
        <div className="inbox__list card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="row" style={{ padding: "10px 12px", borderBottom: "1px solid var(--line-soft)" }}>
            {(["open", "mine", "all"] as const).map((f) => (
              <button
                key={f}
                className="chip"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f === "open" ? "Open" : f === "mine" ? "Mine" : "All"}
              </button>
            ))}
          </div>
          {threads === null ? (
            /* Only the LIST pane skeletons on first load. The thread pane
               keeps its "Pick a conversation" prompt, which is the correct
               empty state rather than a missing one. */
            showSkeleton ? (
              <SkelRows rows={6} />
            ) : (
              <p className="muted" style={{ padding: 14 }}>Loading…</p>
            )
          ) : threads.length === 0 ? (
            <div style={{ padding: 14 }}>
              <p style={{ marginTop: 0 }}>Nothing here yet.</p>
              <p className="muted" style={{ margin: 0 }}>
                Texts to your shop number, voicemails and emails land here as
                conversations. You can also start one from any customer.
              </p>
            </div>
          ) : (
            threads.map((t) => (
              <button
                key={t.id}
                className={`inbox__thread ${openId === t.id ? "is-open" : ""}`}
                onClick={() => void open(t.id)}
                aria-current={openId === t.id ? "true" : undefined}
              >
                <div className="row" style={{ gap: 6 }}>
                  <strong className="grow" style={{ fontWeight: t.unread ? 700 : 550 }}>
                    {title(t)}
                  </strong>
                  {t.unread > 0 && <span className="inbox__dot" aria-label={`${t.unread} unread`} />}
                  <span className="muted" style={{ fontSize: "0.78rem" }}>{when(t.lastMessageAt)}</span>
                </div>
                <div className="muted inbox__preview">
                  {t.previewDirection === "outbound" ? "You: " : ""}
                  {t.preview || "—"}
                </div>
              </button>
            ))
          )}
        </div>

        {/* ───────────────────────────── the thread ─────────────────────── */}
        <div className="inbox__pane">
          {!detail ? (
            <div className="card">
              <p className="muted" style={{ margin: 0 }}>
                Pick a conversation to read it and answer.
              </p>
            </div>
          ) : (
            <>
              <div className="card">
                <div className="row">
                  <button
                    className="secondary inbox__back"
                    onClick={() => setOpenId(null)}
                    aria-label="Back to conversations"
                  >
                    ← All
                  </button>
                  <div className="grow">
                    <strong>{title(detail)}</strong>{" "}
                    <span className="muted">· {detail.contactDisplay}</span>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      {detail.customerId ? (
                        <Link href="/customers">Customer on file</Link>
                      ) : (
                        "Not a customer yet"
                      )}
                      {detail.assignedTo && detail.assignedTo === me ? " · yours" : ""}
                    </div>
                  </div>
                  {/* Triage is a write. A read-only seat gets the conversation
                      and none of the buttons that would 403 on it. */}
                  {canWrite && (
                    <>
                      {!detail.customerId && (
                        <button className="secondary" disabled={busy} onClick={() => void makeCustomer()}>
                          Save as customer
                        </button>
                      )}
                      <button className="secondary" disabled={busy} onClick={() => void claim()}>
                        {detail.assignedTo === me ? "Unassign me" : "Assign to me"}
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void setStatus(detail.status === "open" ? "closed" : "open")}
                      >
                        {detail.status === "open" ? "Mark done" : "Reopen"}
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="card inbox__log">
                {detail.messages.length === 0 && (
                  <p className="muted" style={{ margin: 0 }}>No messages yet.</p>
                )}
                {detail.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`bubble bubble--${m.direction} ${m.channel === "note" ? "bubble--note" : ""}`}
                  >
                    {m.channel === "voice" && (
                      <div className="muted" style={{ fontSize: "0.78rem", marginBottom: 4 }}>
                        📞 {m.subject || "Phone call"}
                        {m.durationSeconds ? ` · ${m.durationSeconds}s` : ""}
                      </div>
                    )}
                    {m.channel === "note" && (
                      <div className="muted" style={{ fontSize: "0.78rem", marginBottom: 4 }}>
                        🔒 Internal note — not sent
                      </div>
                    )}
                    <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
                    {/* Only on an inbound voicemail with something to reply
                        to. A voice message the shop placed, or an empty
                        transcript, has nothing to draft from. */}
                    {draftOn &&
                      m.channel === "voice" &&
                      m.direction === "inbound" &&
                      m.body.trim().length > 0 && (
                        <button
                          className="secondary"
                          style={{ marginTop: 8 }}
                          disabled={busy || draftingId === m.id}
                          onClick={() => void draftFrom(m.id)}
                        >
                          {draftingId === m.id ? "Drafting…" : "✍️ Draft a reply"}
                        </button>
                      )}
                    {m.media.length > 0 && (
                      <div className="row" style={{ marginTop: 8, gap: 8 }}>
                        {/* A plain <img>, deliberately: these bytes come from
                            an AUTHENTICATED route, so next/image's optimizer
                            (which fetches server-side, without the session)
                            cannot load them. */}
                        {m.media.map((md) => (
                          <a key={md.id} href={`/api/inbox/media/${md.id}`} target="_blank" rel="noreferrer">
                            <img
                              src={`/api/inbox/media/${md.id}`}
                              alt="Photo sent by the customer"
                              className="inbox__media"
                            />
                          </a>
                        ))}
                      </div>
                    )}
                    <div className="bubble__meta">
                      {when(m.createdAt)}
                      {m.polished ? " · polished" : ""}
                      {m.status === "failed" ? ` · didn't send: ${m.error}` : ""}
                      {m.status === "queued" ? " · sending…" : ""}
                    </div>
                  </div>
                ))}
                <div ref={bottom} />
              </div>

              {/* ──────────────────────── the reply box ──────────────────── */}
              <div className="card">
                {!canWrite && (
                  <p className="muted" style={{ margin: 0 }}>
                    This is a read-only seat, so there&apos;s no reply box —
                    everything above is a real conversation on a real shop&apos;s
                    books. On a working seat you&apos;d answer right here, and
                    the text would go out from the shop&apos;s own number.
                  </p>
                )}
                {canWrite && detail.reply.blocked && (
                  <p className="muted" style={{ marginTop: 0 }}>⚠️ {detail.reply.blocked}</p>
                )}
                {canWrite && (
                  <>
                <label htmlFor="reply" className="sr-only">Your reply</label>
                <textarea
                  id="reply"
                  rows={4}
                  value={draft}
                  placeholder={
                    detail.reply.channel === "sms"
                      ? "Type a text…"
                      : detail.reply.channel === "email"
                        ? "Type an email…"
                        : "Type a note…"
                  }
                  onChange={(e) => setDraft(e.target.value)}
                  style={{ width: "100%" }}
                />

                {polishOn && (
                  <PolishBox
                    text={draft}
                    // "note" when it stays inside the shop, "reply" when a
                    // customer will read it — the prompt rule differs and so
                    // does how careful the rewrite has to be.
                    surface={detail.reply.channel === null ? "note" : "reply"}
                    label="✨ Polish"
                    disabled={busy}
                    onUse={(polished: string) => {
                      setDraft(polished);
                      setPolishedText(polished);
                      setNote("Swapped in — edit it however you like before sending.");
                    }}
                  />
                )}

                <div className="row" style={{ marginTop: 10 }}>
                  <button
                    disabled={busy || !draft.trim() || draftHasBlanks}
                    title={draftHasBlanks ? "Fill in the [blanks] first" : undefined}
                    onClick={() => void send(false)}
                  >
                    {detail.reply.channel === "email" ? "Send email" : "Send text"}
                  </button>
                  <span className="grow" />
                  <button
                    className="secondary"
                    disabled={busy || !draft.trim()}
                    onClick={() => void send(true)}
                    title="Saved on the thread, never sent to the customer"
                  >
                    Save as note
                  </button>
                </div>
                {polishOn && (
                  <p className="muted" style={{ margin: "8px 0 0", fontSize: "0.8rem" }}>
                    Polish rewrites your wording only. It can&apos;t change a
                    price, a date or a promise — if it tries, the rewrite is
                    thrown out and you keep what you typed. Nothing sends until
                    you press send.
                  </p>
                )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div role="status" aria-live="polite">
        {note && <p className="gain">{note}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </AppShell>
  );
}
