"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import { api, ApiError } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import PolishBox, { type PolishSurface } from "@/components/PolishBox";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Item {
  type: "decide" | "link";
  id: string;
  title: string;
  detail: string;
  href: string;
  actionId?: string;
  /** The registry kind — picks the polish surface for the reword box. */
  kind?: string;
  /**
   * Fields this card's kind says a human may reword before approving. Absent
   * on every other card, which is why the box below only appears where a
   * person is actually meant to change words.
   */
  editable?: Record<string, string>;
}

/**
 * Which polish rules apply to a reworded card.
 *
 * Both of these are ESCALATION-GATED surfaces: a rewrite that gains
 * "collections", "attorney" or "late fee" when the draft had none is thrown
 * out whole. That is the reason a reword box is safe to put on a screen whose
 * next button sends the words to a customer.
 */
const SURFACE_FOR_KIND: Record<string, PolishSurface> = {
  "ar.dunningDraft": "dunning",
  "crm.reviewRequest": "review_request",
  "sales.outreachDraft": "outreach",
};
interface Group {
  key: string;
  name: string;
  items: Item[];
}

/**
 * Everything waiting on a human, one screen, grouped by department.
 *
 * Helper cards act INLINE (the decide API enforces per-kind authz and
 * maker≠checker); documents open IN THEIR OWN screen, where the real editor
 * lives. What you see here is already filtered to your access — a person with
 * only the field wall sees only field work.
 */
export default function ApprovalsPage() {
  const router = useRouter();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  /** Per-card reworded text, keyed by item id then field name. */
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState("");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(groups !== null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ groups: Group[] }>("/api/approvals");
      setGroups(r.groups);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load the inbox.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(item: Item, type: "approve" | "reject") {
    if (!item.actionId) return;
    setBusyId(item.id);
    setError("");
    setNote("");
    try {
      /**
       * If the person reworded the draft, this is a REVISE, not an approve.
       *
       * The distinction is not cosmetic: the gate records an approve as a
       * positive case and a revise as a preference the helper learns from, so
       * sending "approve" with edited words would teach it that the draft it
       * wrote was the one you wanted.
       *
       * Only fields the kind opened are sent, and the gate re-checks that list
       * server-side — the screen cannot widen what is revisable by asking.
       */
      const edits = Object.fromEntries(
        Object.entries(drafts[item.id] ?? {}).filter(
          ([field, value]) => value.trim() && value !== item.editable?.[field],
        ),
      );
      const body =
        type === "approve" && Object.keys(edits).length > 0
          ? { type: "revise" as const, edit: edits }
          : { type };
      await api(`/api/agents/actions/${item.actionId}/decide`, {
        method: "POST",
        json: body,
      });
      setNote(
        type !== "approve"
          ? "Denied — the helper learns from it."
          : Object.keys(edits).length > 0
            ? "Sent with your wording — the helper learns from the change."
            : "Approved and executed.",
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work — try again.");
    } finally {
      setBusyId(null);
      await load();
    }
  }

  const total = groups?.reduce((s, g) => s + g.items.length, 0) ?? 0;

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!groups) {
    return (
      <AppShell title="Approvals">
        {showSkeleton && <PageSkeleton kind="list" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Approvals">
      {groups === null ? (
        <p className="muted">Loading…</p>
      ) : total === 0 ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Nothing waiting on you ✅</h2>
          <p className="muted" style={{ margin: 0 }}>
            Helper proposals, bank lines, unbilled POs, new calls and finished
            weeks all land here the moment they need a decision.
          </p>
        </div>
      ) : (
        groups.map((g) =>
          g.items.length === 0 ? null : (
            <div key={g.key}>
              <h2>
                {g.name}{" "}
                <span className="muted" style={{ fontWeight: 400 }}>
                  · {g.items.length}
                </span>
              </h2>
              <div className="card">
                {g.items.map((item) => (
                  <div key={item.id} style={{ padding: "8px 0" }}>
                    <div className="row" style={{ alignItems: "center" }}>
                    <div className="grow">
                      <div>{item.title}</div>
                      <div className="muted" style={{ fontSize: "0.85rem" }}>
                        {item.detail}
                      </div>
                    </div>
                    {item.type === "decide" ? (
                      <>
                        <button
                          disabled={busyId === item.id}
                          onClick={() => void decide(item, "approve")}
                        >
                          Approve
                        </button>
                        <button
                          className="secondary"
                          disabled={busyId === item.id}
                          onClick={() => void decide(item, "reject")}
                        >
                          Deny
                        </button>
                        <Link href={item.href} className="muted" style={{ fontSize: "0.85rem" }}>
                          open
                        </Link>
                      </>
                    ) : (
                      <Link href={item.href}>
                        <button className="secondary">Open</button>
                      </Link>
                    )}
                    </div>

                    {/* The words that will actually reach a customer, editable
                        in place. Rendered ONLY where the kind opened a field —
                        every other card keeps its one-line approve/deny. */}
                    {item.editable &&
                      Object.entries(item.editable).map(([field, original]) => {
                        const value = drafts[item.id]?.[field] ?? original;
                        const changed = value !== original;
                        const setValue = (next: string) =>
                          setDrafts((d) => ({
                            ...d,
                            [item.id]: { ...(d[item.id] ?? {}), [field]: next },
                          }));
                        return (
                          <div key={field} style={{ marginTop: 6, marginBottom: 4 }}>
                            <label htmlFor={item.id + "-" + field} className="sr-only">
                              Message to send
                            </label>
                            <textarea
                              id={item.id + "-" + field}
                              rows={3}
                              value={value}
                              onChange={(e) => setValue(e.target.value.slice(0, 2000))}
                              style={{ width: "100%" }}
                            />
                            <div className="row" style={{ alignItems: "center" }}>
                              <span className="muted" style={{ fontSize: "0.8rem" }}>
                                {changed
                                  ? "Your wording — approving sends this."
                                  : "The helper's wording. Edit it if you like."}
                              </span>
                              <span className="grow" />
                              {changed && (
                                <button
                                  className="secondary"
                                  onClick={() => setValue(original)}
                                  disabled={busyId === item.id}
                                >
                                  Undo my edits
                                </button>
                              )}
                            </div>
                            <PolishBox
                              text={value}
                              surface={SURFACE_FOR_KIND[item.kind ?? ""] ?? "reply"}
                              showTone={false}
                              disabled={busyId === item.id}
                              label="✨ Polish this"
                              onUse={setValue}
                            />
                          </div>
                        );
                      })}
                  </div>
                ))}
              </div>
            </div>
          ),
        )
      )}
      <div role="status" aria-live="polite">
        {note && <p className="gain">{note}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </AppShell>
  );
}
