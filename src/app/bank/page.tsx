"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, centsFromInput, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";
import AnswerForm, { type AnswerAction } from "@/components/AnswerForm";
import type { CategoryOption } from "@/components/CategoryPicker";
import FeedConnections from "@/components/FeedConnections";

interface Account {
  id: string;
  name: string;
  glAccountCode: string;
  kind: string;
}
interface Txn {
  id: string;
  bankAccountId: string;
  postedOn: string;
  amountCents: number;
  description: string;
  status: string;
  personalSuspect: boolean;
  personalReason: string | null;
  suggestion: null | { ruleId: string; action: string; accountCode: string | null };
}
interface PostedTxn {
  id: string;
  postedOn: string;
  amountCents: number;
  description: string;
  status: string;
  bankAccountName: string;
  codedToCode: string | null;
  codedToName: string | null;
  jobId: string | null;
  jobNo: number | null;
  jobName: string | null;
  costCode: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  answerCount: number;
}
interface JobRow {
  id: string;
  jobNo: number;
  name: string;
}
interface CostCode {
  code: string;
  name: string;
  kind: string;
}

type Tab = "queue" | "posted";

export default function BankPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [queue, setQueue] = useState<Txn[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [costCodes, setCostCodes] = useState<CostCode[]>([]);
  const [accountId, setAccountId] = useState("");
  const [newAccountName, setNewAccountName] = useState("");
  // The add-account card used to render ONLY when a shop had zero accounts,
  // and sent {name} alone — so a second account was unreachable and every
  // account ever created was a checking account on 1020. Credit cards were
  // real in the database and impossible to get to from the screen.
  const [addingAccount, setAddingAccount] = useState(false);
  const [newAccountKind, setNewAccountKind] = useState("checking");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("queue");
  const [openRow, setOpenRow] = useState<string | null>(null);
  // the "already categorized" side
  const [posted, setPosted] = useState<PostedTxn[]>([]);
  const [postedLoaded, setPostedLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  // Reconciling used to mean "the queue is empty", which is not reconciled.
  // These hold the number the bank printed and the difference against it.
  const [stmtEnding, setStmtEnding] = useState("");
  const [stmtDate, setStmtDate] = useState(new Date().toISOString().slice(0, 10));
  const [diffReason, setDiffReason] = useState("");
  const [book, setBook] = useState<{ bookBalanceCents: number; sharedGlAccount: boolean } | null>(null);
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      const [a, q, j, cats] = await Promise.all([
        api<{ accounts: Account[] }>("/api/bank/accounts"),
        api<{ txns: Txn[] }>("/api/bank/txns?status=pending"),
        api<{ jobs: JobRow[] }>("/api/jobs"),
        api<{ categories: CategoryOption[]; costCodes: CostCode[] }>("/api/bank/categories"),
      ]);
      setAccounts(a.accounts);
      setQueue(q.txns);
      setJobs(j.jobs);
      setCategories(cats.categories);
      setCostCodes(cats.costCodes);
      setAccountId((cur) => cur || a.accounts[0]?.id || "");
      setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.push("/login");
      } else setError("Couldn't load the bank screen.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The posted list is fetched only when somebody opens that tab — it is a
   *  second query over the ledger and most visits here never look at it. */
  const loadPosted = useCallback(async (q: string) => {
    try {
      const r = await api<{ txns: PostedTxn[] }>(
        `/api/bank/posted${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`,
      );
      setPosted(r.txns);
      setPostedLoaded(true);
    } catch {
      setError("Couldn't load what's already categorized.");
    }
  }, []);

  useEffect(() => {
    if (tab === "posted" && !postedLoaded) void loadPosted("");
  }, [tab, postedLoaded, loadPosted]);

  // What the BOOKS say this account holds, so the difference is on screen
  // before anybody commits to locking a period.
  useEffect(() => {
    if (!accountId) return;
    void api<{ bookBalanceCents: number; sharedGlAccount: boolean }>(
      `/api/bank/reconcile?bankAccountId=${accountId}&asOf=${stmtDate}`,
    )
      .then(setBook)
      .catch(() => setBook(null));
  }, [accountId, stmtDate, queue.length]);

  async function createAccount() {
    setBusy(true);
    try {
      await api("/api/bank/accounts", {
        method: "POST",
        json: { name: newAccountName, kind: newAccountKind },
      });
      setNewAccountName("");
      setAddingAccount(false);
      await load();
    } catch {
      setError("Couldn't add that account.");
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const form = new FormData();
      form.append("bankAccountId", accountId);
      form.append("file", file);
      const res = await fetch("/api/bank/import", { method: "POST", body: form });
      if (!res.ok) throw new Error("import failed");
      const s = (await res.json()) as {
        rowsNew: number;
        rowsDuplicate: number;
        rowsSkipped: number;
        autoMatched: number;
      };
      setNote(
        `Imported ${s.rowsNew} new transaction${s.rowsNew === 1 ? "" : "s"} — ` +
          `${s.autoMatched} matched your books automatically, ` +
          `${s.rowsDuplicate} already imported (skipped), ${s.rowsSkipped} unreadable.`,
      );
      await load();
    } catch {
      setError("Import didn't work — is it a CSV or OFX/QFX statement file?");
    } finally {
      setBusy(false);
    }
  }

  async function resolve(txn: Txn, action: AnswerAction) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/bank/txns/${txn.id}/resolve`, { method: "POST", json: action });
      setOpenRow(null);
      await load();
      // What was just answered now belongs on the other list.
      if (postedLoaded) await loadPosted(search);
    } catch {
      setError("Couldn't save that — try again.");
    } finally {
      setBusy(false);
    }
  }

  /** Change an answer that is already posted. The server reverses the old
   *  entry and posts the new one; nothing is edited or erased. */
  async function recategorize(id: string, action: AnswerAction, reason: string) {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ bookedOn: string }>(`/api/bank/txns/${id}/recategorize`, {
        method: "POST",
        json: { action, reason },
      });
      setEditing(null);
      setNote(
        `Recoded. The old entry was reversed and the new one posted on ${r.bookedOn} — both stay in the ledger.`,
      );
      await loadPosted(search);
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "changed_by_someone_else"
          ? "Somebody else changed this line while you were working — reload and take another look."
          : "Couldn't change that — try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** A matched line is one the statement met a payment ALREADY on the books.
   *  Unlinking puts it back in the queue and leaves that payment alone. */
  async function unlink(id: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/bank/txns/${id}/recategorize`, {
        method: "POST",
        json: { action: { type: "unmatch" }, reason: "Not the payment this was matched to" },
      });
      setNote("Unlinked — it's back in 'Needs an answer'. The payment itself wasn't touched.");
      await loadPosted(search);
      await load();
    } catch {
      setError("Couldn't unlink that — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function askBookkeeper() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ proposed: number; duplicates: number }>(
        "/api/agents/financials/run",
        { method: "POST", json: {} },
      );
      setNote(
        r.proposed > 0
          ? `The bookkeeper wrote ${r.proposed} question${r.proposed === 1 ? "" : "s"} for you — answer them under Helpers.`
          : "The bookkeeper already asked about everything here — check Helpers.",
      );
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "agent_off"
          ? "The bookkeeper is turned off — flip it to 'Ask first' under Helpers."
          : "Couldn't run the bookkeeper — try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function reconcileNow() {
    // ⛔ `Math.round(Number(stmtEnding) * 100)` produced NaN — which
    // JSON.stringify turns into `null` — the moment anyone typed a balance
    // the way a bank statement prints one: "12,345.67". The comma is not an
    // edge case here, it is the format on the piece of paper the number is
    // being copied from. centsFromInput already handles "$", commas and
    // spaces, and rounds half-up the same way the server does.
    const endingCents = centsFromInput(stmtEnding);
    if (endingCents === null) {
      setError(
        "That ending balance didn't read as an amount. Copy it from the statement — \"12,345.67\" or \"$12,345.67\" are both fine.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api<{
        txnCount: number;
        bookBalanceCents: number;
        differenceCents: number;
      }>("/api/bank/reconcile", {
        method: "POST",
        json: {
          bankAccountId: accountId,
          periodEnd: stmtDate,
          statementEndingCents: endingCents,
          differenceReason: diffReason.trim() || undefined,
        },
      });
      setNote(
        r.differenceCents === 0
          ? `Reconciled and locked: ${r.txnCount} transactions, and your books agree with the statement to the penny.`
          : `Locked with a noted difference of ${dollars(Math.abs(r.differenceCents))}. That reason is on the record — chase it down and it can be corrected with an adjusting entry.`,
      );
      setStmtEnding("");
      setDiffReason("");
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code.startsWith("queue_not_clear")) {
        setError("Can't reconcile yet — clear the review list first (every line needs an answer).");
      } else if (e instanceof ApiError && e.code.startsWith("out_of_balance")) {
        setError(
          "Your books and the statement don't agree. Find it, or write down why before locking the period.",
        );
      } else {
        setError("Reconcile didn't work (maybe this period is already locked).");
      }
    } finally {
      setBusy(false);
    }
  }

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Bank">
        {showSkeleton && <PageSkeleton kind="table" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Bank & reconciliation">
      {(accounts.length === 0 || addingAccount) && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>
            {accounts.length === 0 ? "Add your bank account" : "Add another account"}
          </h2>
          <p className="muted">
            Name it what you call it — &quot;Chase Business Checking&quot; works.
            Statement uploads and CSV imports work on any account. To have
            transactions arrive on their own instead,{" "}
            <Link href="/bank/connect">connect the bank directly</Link>.
          </p>
          <div className="row">
            <div className="grow">
              <label htmlFor="bname">What do you call it?</label>
              <input
                id="bname"
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                placeholder="Chase Business Checking"
              />
            </div>
            <div>
              <label htmlFor="bkind">What kind of account?</label>
              {/* ⛔ NOT COSMETIC. A credit card is a LIABILITY: a charge
                  increases what the shop owes. Treating one as cash puts
                  card debt on the balance sheet as negative cash, which is
                  the sheet a banker and a surety read first. */}
              <select
                id="bkind"
                value={newAccountKind}
                onChange={(e) => setNewAccountKind(e.target.value)}
              >
                <option value="checking">Checking</option>
                <option value="savings">Savings</option>
                <option value="credit-card">Credit card</option>
                <option value="line-of-credit">Line of credit</option>
                <option value="loan">Loan</option>
              </select>
            </div>
            <button
              style={{ alignSelf: "flex-end" }}
              onClick={createAccount}
              disabled={busy || !newAccountName.trim()}
            >
              Add account
            </button>
            {accounts.length > 0 && (
              <button
                className="secondary"
                style={{ alignSelf: "flex-end" }}
                onClick={() => setAddingAccount(false)}
              >
                Cancel
              </button>
            )}
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Credit cards post to what you owe, not to cash — so your balance
            sheet stays right and paying the card off shows up as the transfer
            it is.
          </p>
        </div>
      )}

      {accounts.length > 0 && (
        <div className="card">
          <div className="row">
            <div className="grow">
              <label htmlFor="bacct">Account</label>
              <select id="bacct" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.kind && a.kind !== "checking" ? ` (${a.kind.replace("-", " ")})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="secondary"
              style={{ alignSelf: "flex-end" }}
              onClick={() => setAddingAccount(true)}
            >
              + Add account
            </button>
            <label className="pill" style={{ cursor: "pointer", padding: "10px 14px", alignSelf: "flex-end" }}>
              📄 Upload statement (CSV/OFX)
              <input
                type="file"
                accept=".csv,.ofx,.qfx,text/csv"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFile(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>

          {/* ⛔ RECONCILING IS A COMPARISON, NOT A CHECKBOX. The old button
              only checked that the review queue was empty — which misses a
              statement line that never imported, a duplicate the dedupe
              missed, and a payment somebody keyed in that never happened.
              None of those leave anything in the queue. */}
          <div className="row">
            <div>
              <label htmlFor="stmtdate">Statement date</label>
              <input
                id="stmtdate"
                type="date"
                value={stmtDate}
                onChange={(e) => setStmtDate(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="stmtend">Ending balance on the statement</label>
              <input
                id="stmtend"
                inputMode="decimal"
                placeholder="6,956.00"
                style={{ width: 150 }}
                value={stmtEnding}
                onChange={(e) => setStmtEnding(e.target.value)}
              />
            </div>
            {book && (
              <div style={{ alignSelf: "flex-end" }}>
                <div className="muted">Your books say</div>
                <strong>{dollars(book.bookBalanceCents)}</strong>
              </div>
            )}
            {book && stmtEnding.trim() !== "" && (
              <div style={{ alignSelf: "flex-end" }} aria-live="polite">
                <div className="muted">Difference</div>
                <strong>
                  {dollars(book.bookBalanceCents - Math.round(Number(stmtEnding) * 100))}
                </strong>
              </div>
            )}
            <button
              className="secondary"
              style={{ alignSelf: "flex-end" }}
              disabled={busy || queue.length > 0 || stmtEnding.trim() === ""}
              onClick={reconcileNow}
              title={
                queue.length > 0
                  ? "Clear the review list first"
                  : stmtEnding.trim() === ""
                    ? "Enter the ending balance from the statement"
                    : ""
              }
            >
              ✓ Reconcile &amp; lock
            </button>
          </div>
          {book?.sharedGlAccount && (
            <p className="muted" style={{ marginBottom: 0 }}>
              Two or more of your bank accounts post to the same ledger
              account, so this balance covers all of them. Give each account
              its own ledger code to reconcile them separately.
            </p>
          )}
          {book && stmtEnding.trim() !== "" &&
            book.bookBalanceCents !== Math.round(Number(stmtEnding) * 100) && (
              <div>
                <label htmlFor="diffwhy">
                  Books and statement don&apos;t agree. What is the difference?
                </label>
                <input
                  id="diffwhy"
                  value={diffReason}
                  onChange={(e) => setDiffReason(e.target.value)}
                  placeholder="Bank error on the 14th — disputed, credit expected"
                />
                <p className="muted" style={{ marginBottom: 0 }}>
                  You can still lock the period, but the reason goes on the
                  record with your name and it will not count as a clean
                  reconciliation.
                </p>
              </div>
            )}
          {queue.length > 0 && (
            <p className="muted" style={{ marginBottom: 0 }}>
              Reconciling unlocks when every line below has an answer.{" "}
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void askBookkeeper()}
              >
                🤝 Ask the bookkeeper
              </button>{" "}
              It turns each line into a plain-language question — nothing
              posts until you say yes.
            </p>
          )}
        </div>
      )}

      <FeedConnections onChanged={() => void load()} />

      {/* Two lists, one screen. "Already categorized" is the half that was
          missing: everybody miscodes something, and a book you cannot correct
          is a book people stop trusting. */}
      <div className="row" role="group" aria-label="Which transactions">
        <button
          type="button"
          className="chip"
          aria-pressed={tab === "queue"}
          onClick={() => setTab("queue")}
        >
          Needs an answer ({queue.length})
        </button>
        <button
          type="button"
          className="chip"
          aria-pressed={tab === "posted"}
          onClick={() => setTab("posted")}
        >
          Already categorized
        </button>
      </div>

      {tab === "queue" && (
        <>
          {queue.length === 0 && (
            <div className="card">
              <p style={{ margin: 0 }}>
                Nothing to review. Every bank line is accounted for — that&apos;s
                what &quot;reconciled clean&quot; means.
              </p>
            </div>
          )}
          {queue.map((t) => (
            <div key={t.id} className="card">
              <div className="row">
                <div className="grow">
                  <strong>{t.description}</strong>
                  <div className="muted">
                    {t.postedOn} · {t.amountCents < 0 ? "−" : "+"}{dollars(Math.abs(t.amountCents))}
                    {t.amountCents < 0 ? " out" : " in"}
                  </div>
                </div>
                {t.personalSuspect && (
                  <span className="pill" style={{ background: "var(--warn-bg)" }}>
                    looks personal{t.personalReason ? ` (${t.personalReason})` : ""}
                  </span>
                )}
                {t.suggestion && (
                  <span className="pill">
                    suggested: {t.suggestion.action}
                    {t.suggestion.accountCode ? ` → ${t.suggestion.accountCode}` : ""}
                  </span>
                )}
              </div>
              {openRow === t.id ? (
                <AnswerForm
                  amountCents={t.amountCents}
                  categories={categories}
                  costCodes={costCodes}
                  jobs={jobs}
                  accounts={accounts}
                  thisAccountId={t.bankAccountId}
                  busy={busy}
                  submitLabel="Save this answer"
                  onSubmit={(action) => void resolve(t, action)}
                  onCancel={() => setOpenRow(null)}
                />
              ) : (
                <div className="row" style={{ marginTop: 8 }}>
                  {t.suggestion?.action === "expense" && t.suggestion.accountCode && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void resolve(t, {
                          type: "expense",
                          accountCode: t.suggestion!.accountCode!,
                          remember: true,
                        })
                      }
                    >
                      ✓ Yes, {categoryName(categories, t.suggestion.accountCode)} again
                    </button>
                  )}
                  {t.personalSuspect && (
                    <button className="secondary" disabled={busy} onClick={() => void resolve(t, { type: "personal" })}>
                      Mark personal
                    </button>
                  )}
                  <button className="secondary" disabled={busy} onClick={() => setOpenRow(t.id)}>
                    Answer…
                  </button>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {tab === "posted" && (
        <>
          <div className="card">
            <div className="row">
              <div className="grow">
                <label className="muted" htmlFor="psearch">Find a transaction</label>
                <input
                  id="psearch"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void loadPosted(search);
                  }}
                  placeholder="ADP, Home Depot, fuel…"
                />
              </div>
              <button
                className="secondary"
                style={{ alignSelf: "flex-end" }}
                disabled={busy}
                onClick={() => void loadPosted(search)}
              >
                Search
              </button>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              Coded wrong? Change it. The original entry is reversed and the new
              one posted — both stay in the ledger with your name on the change,
              which is what makes these books hold up to an auditor.
            </p>
          </div>

          {postedLoaded && posted.length === 0 && (
            <div className="card">
              <p style={{ margin: 0 }}>Nothing categorized yet.</p>
            </div>
          )}

          {posted.map((p) => (
            <div key={p.id} className="card">
              <div className="row">
                <div className="grow">
                  <strong>{p.description}</strong>
                  <div className="muted">
                    {p.postedOn} · {p.amountCents < 0 ? "−" : "+"}{dollars(Math.abs(p.amountCents))}
                    {" · "}{p.bankAccountName}
                  </div>
                </div>
                <span className="pill">{codedLabel(p)}</span>
                {p.answerCount > 1 && (
                  <span className="pill" style={{ background: "var(--warn-bg)" }}>
                    changed {p.answerCount - 1}×
                  </span>
                )}
              </div>
              {editing === p.id ? (
                <AnswerForm
                  amountCents={p.amountCents}
                  categories={categories}
                  costCodes={costCodes}
                  jobs={jobs}
                  busy={busy}
                  requireReason
                  submitLabel="Recode it"
                  onSubmit={(action, reason) => void recategorize(p.id, action, reason)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="row" style={{ marginTop: 8 }}>
                  {p.status === "matched" ? (
                    <>
                      <span className="muted grow">
                        Matched to money already on your books — that entry belongs
                        to the payment, not to this line.
                      </span>
                      <button className="secondary" disabled={busy} onClick={() => void unlink(p.id)}>
                        Not that payment — unlink
                      </button>
                    </>
                  ) : (
                    <button className="secondary" disabled={busy} onClick={() => setEditing(p.id)}>
                      Change this…
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}

/** The suggestion chip used to read "Yes, 6210 again". A code is not a
 *  category — say the name when we have one. */
function categoryName(categories: CategoryOption[], code: string): string {
  return categories.find((c) => c.code === code)?.name ?? code;
}

/** What this line was coded to, in the words somebody would use out loud. */
function codedLabel(p: PostedTxn): string {
  if (p.status === "excluded") return "not ours / duplicate";
  if (p.status === "personal") return "personal — owner draw";
  if (p.jobNo !== null) {
    return `job #${p.jobNo}${p.costCode ? ` · ${p.costCode}` : ""}`;
  }
  if (p.codedToName) return p.codedToName;
  if (p.status === "matched") return "matched to your books";
  return "posted";
}
