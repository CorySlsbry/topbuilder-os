"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Policy {
  agentKey: string;
  mode: "off" | "approve" | "auto";
}
interface Action {
  id: string;
  agentKey: string;
  kind: string;
  status: string;
  summary: string;
  payload: Record<string, unknown>;
  confidence: number | null;
  proposedBy: string;
  decidedBy: string | null;
  error: string | null;
  createdAt: string;
}
interface DeadLetter {
  id: string;
  agentKey: string;
  assessment: string;
  createdAt: string;
}
interface Preference {
  id: string;
  agentKey: string;
  rule: string;
  status: string;
  approvers: string[];
}
interface Overview {
  policies: Policy[];
  pending: Action[];
  recent: Action[];
  deadLetters: DeadLetter[];
  preferences: Preference[];
  cost: { todayMicroUsd: number; capMicroUsd: number };
}

const AGENT_LABELS: Record<string, string> = {
  echo: "Echo (test helper)",
  financials: "Bookkeeper — reads your bank queue, asks plain questions",
  documents: "Paperwork — turns received POs into bills to approve",
  workforce: "Timekeeper — turns finished weeks into labor costs to approve",
  inventory: "Restocker — flags low stock and drafts the reorder PO",
  dispatch: "Dispatcher — assigns open appointments to the least-busy worker",
  booking: "Receptionist — books new requests into real open slots",
  crm: "Front Desk — drafts review asks and friendly payment reminders",
  sales: "Sales — drafts win-back texts for the week's top targets",
};

export default function AgentsPage() {
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reviseId, setReviseId] = useState<string | null>(null);
  const [reviseAccount, setReviseAccount] = useState("");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(data !== null);

  const load = useCallback(async () => {
    try {
      setData(await api<Overview>("/api/agents/overview"));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load the command center.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch {
      setError("That didn't work — try again.");
    } finally {
      setBusy(false);
      await load();
    }
  }

  // Was a bare `main.shell` with no loading text at all — a blank white page
  // that also dropped the whole app shell. Two bugs in one line.
  if (!data) {
    return (
      <AppShell title="Your helpers">
        {showSkeleton && <PageSkeleton kind="list" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Your helpers">
      <p className="muted">
        Helpers do paperwork and propose — they never move money on their own.
        Anything that touches your books waits for your yes. Every yes, edit,
        or no teaches them. Today&apos;s helper spend:{" "}
        {dollars(Math.round(data.cost.todayMicroUsd / 10000))} of{" "}
        {dollars(Math.round(data.cost.capMicroUsd / 10000))} cap.
      </p>

      <h2>On / Ask first / Auto</h2>
      {data.policies.map((p) => (
        <div key={p.agentKey} className="card">
          <div className="row">
            <div className="grow">
              <strong>{AGENT_LABELS[p.agentKey] ?? p.agentKey}</strong>
              <div className="muted">
                {p.mode === "off"
                  ? "Off — does nothing."
                  : p.mode === "approve"
                    ? "Ask first — proposes, you approve."
                    : "Auto — acts on routine items; money always asks first."}
              </div>
            </div>
            {(["off", "approve", "auto"] as const).map((m) => (
              <button
                key={m}
                className={p.mode === m ? undefined : "secondary"}
                disabled={busy || p.mode === m}
                onClick={() =>
                  void act(() =>
                    api("/api/agents/policies", {
                      method: "PUT",
                      json: { agentKey: p.agentKey, mode: m },
                    }),
                  )
                }
              >
                {m === "off" ? "Off" : m === "approve" ? "Ask first" : "Auto"}
              </button>
            ))}
          </div>
        </div>
      ))}

      {data.deadLetters.length > 0 && (
        <>
          <h2>Stopped itself</h2>
          {data.deadLetters.map((d) => (
            <div key={d.id} className="card" style={{ borderColor: "#c53030" }}>
              <p style={{ margin: 0 }}>{d.assessment}</p>
            </div>
          ))}
        </>
      )}

      <h2>Waiting for your answer ({data.pending.length})</h2>
      {data.pending.length === 0 && (
        <div className="card">
          <p style={{ margin: 0 }} className="muted">
            Nothing pending.
          </p>
        </div>
      )}
      {data.pending.map((a) => (
        <div key={a.id} className="card">
          <p style={{ marginTop: 0 }}>
            <strong>{a.summary}</strong>
          </p>
          <p className="muted">
            {a.kind} · proposed by {a.proposedBy}
            {a.confidence !== null ? ` · confidence ${a.confidence}%` : ""}
          </p>
          <div className="row">
            <button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(`/api/agents/actions/${a.id}/decide`, {
                    method: "POST",
                    json: { type: "approve" },
                  }),
                )
              }
            >
              ✓ Approve
            </button>
            {a.kind === "bank.categorize" && a.payload.action === "expense" && (
              reviseId === a.id ? (
                <>
                  <input
                    value={reviseAccount}
                    onChange={(e) => setReviseAccount(e.target.value)}
                    style={{ width: 110 }}
                    aria-label="Different account code"
                    placeholder="account"
                  />
                  <button
                    disabled={busy || !reviseAccount.trim()}
                    onClick={() =>
                      void act(() =>
                        api(`/api/agents/actions/${a.id}/decide`, {
                          method: "POST",
                          json: { type: "revise", edit: { accountCode: reviseAccount.trim() } },
                        }),
                      )
                    }
                  >
                    Use this account
                  </button>
                </>
              ) : (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setReviseId(a.id);
                    setReviseAccount(String(a.payload.accountCode ?? ""));
                  }}
                >
                  Different account…
                </button>
              )
            )}
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(`/api/agents/actions/${a.id}/decide`, {
                    method: "POST",
                    json: { type: "reject" },
                  }),
                )
              }
            >
              ✗ No
            </button>
          </div>
        </div>
      ))}

      <h2>What they learned</h2>
      {data.preferences.length === 0 && (
        <div className="card">
          <p style={{ margin: 0 }} className="muted">
            Nothing yet — edits you make to proposals show up here as rules
            you can approve or throw out.
          </p>
        </div>
      )}
      {data.preferences.map((p) => (
        <div key={p.id} className="card">
          <p style={{ marginTop: 0 }}>{p.rule}</p>
          <p className="muted">
            {p.status === "quarantined"
              ? `Waiting for approval (${p.approvers.length} so far)`
              : p.status}
          </p>
          {p.status === "quarantined" && (
            <div className="row">
              <button
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api(`/api/agents/preferences/${p.id}`, {
                      method: "POST",
                      json: { action: "approve" },
                    }),
                  )
                }
              >
                Approve rule
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api(`/api/agents/preferences/${p.id}`, {
                      method: "POST",
                      json: { action: "demote" },
                    }),
                  )
                }
              >
                Throw out
              </button>
            </div>
          )}
          {p.status === "active" && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(`/api/agents/preferences/${p.id}`, {
                    method: "POST",
                    json: { action: "demote" },
                  }),
                )
              }
            >
              Turn this rule off
            </button>
          )}
        </div>
      ))}

      <h2>Recent activity</h2>
      <div className="card">
        {data.recent.length === 0 && <p className="muted" style={{ margin: 0 }}>None yet.</p>}
        {data.recent.map((a) => (
          <p key={a.id} style={{ margin: "4px 0" }}>
            <span className="pill">{a.status}</span> {a.summary}
            {a.status === "executed" && (
              <button
                className="secondary"
                style={{ marginLeft: 8 }}
                disabled={busy}
                onClick={() =>
                  void act(() => api(`/api/agents/actions/${a.id}/undo`, { method: "POST", json: {} }))
                }
              >
                Undo
              </button>
            )}
          </p>
        ))}
      </div>

      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
