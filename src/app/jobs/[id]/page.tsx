"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError, centsFromInput, dollars, newIdempotencyKey } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import CostCodeSelect, { type CostCodeOption } from "@/components/CostCodeSelect";
import PolishBox from "@/components/PolishBox";
import JobForms from "@/components/JobForms";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

/**
 * Both shapes of /api/jobs/[id]/profit, narrowed to what this card needs.
 *
 * The owner's response carries more (collected profit, the WIP comparison,
 * the unposted-labor detail) and the crew's carries less, but these four
 * figures plus the sentence are present in both — which is what lets this be
 * ONE card rather than two that drift apart. The richer owner view lives on
 * /jobs/[id]/money.
 */
interface JobProfitCard {
  view: "full" | "crew";
  profit: {
    billedCents: number;
    totalCostsCents: number;
    billedProfitCents: number;
    billedMarginBps: number;
  };
  explain: string;
}

interface Screen {
  job: {
    id: string;
    job_no: number;
    name: string;
    job_type: string;
    status: string;
    contract_cents: string | number;
    budget_cents: string | number;
    claim_number: string | null;
    carrier: string | null;
    rcv_cents: string | number | null;
    depreciation_invoiced: boolean;
  };
  costTotalCents: number;
  appointmentCount: number;
  depreciationNudge: boolean;
  attachments: {
    id: string;
    kind: string;
    originalName: string | null;
    contentType: string;
  }[];
}

const STATUSES = ["lead", "scheduled", "in-progress", "complete", "closed"] as const;

interface InvoiceRow {
  id: string;
  invoiceNo: number;
  status: string;
  subtotalCents: number;
  taxCents: number;
  retainageCents: number;
  dueNowCents: number;
  paidCents: number;
}

interface ChangeOrder {
  id: string;
  coNo: number;
  status: "draft" | "sent" | "approved" | "declined" | "void";
  title: string;
  reason: string;
  totalCents: number;
  approvedVia: string;
}
interface JobContract {
  summary: {
    originalCents: number;
    addedCents: number;
    deductedCents: number;
    currentCents: number;
    changeOrderCount: number;
  };
  explain: string;
  changeOrders: ChangeOrder[];
}

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [s, setS] = useState<Screen | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // cost form
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("material");
  // Was hardcoded "4100" in a free-text box: a NAHB homebuilder account
  // that means nothing to a trades shop, typed by hand or left alone.
  const [costCode, setCostCode] = useState("");
  const [costCodes, setCostCodes] = useState<CostCodeOption[]>([]);
  const [memo, setMemo] = useState("");

  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  /** What the invoice is FOR, in the customer's words. The invoices API has
   *  always accepted this; until now no screen sent one. */
  const [invMemo, setInvMemo] = useState("");
  const [contractInfo, setContractInfo] = useState<JobContract | null>(null);
  /**
   * Job profit, when this person is allowed to see it.
   *
   * null covers three different situations on purpose — the shop has it
   * switched off, this person is not allowed, or the read failed — because
   * they all render the same way: nothing. A screen that says "you are not
   * allowed to see this" tells a crew member the number exists and that the
   * boss is hiding it, which is worse for a shop than silence.
   */
  const [profit, setProfit] = useState<JobProfitCard | null>(null);
  const [coTitle, setCoTitle] = useState("");
  const [coReason, setCoReason] = useState("");
  const [coAmount, setCoAmount] = useState("");
  const [coDeduct, setCoDeduct] = useState(false);
  const [invAmount, setInvAmount] = useState("");
  const [invRetainage, setInvRetainage] = useState("0");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(s !== null);

  const load = useCallback(async () => {
    try {
      setS(await api<Screen>(`/api/jobs/${id}`));
      // The shop's own cost codes. Unwalled on purpose — a code is a label
      // for what kind of work a cost was, not a dollar figure.
      void api<{ costCodes: CostCodeOption[] }>("/api/cost-codes")
        .then((r) => {
          setCostCodes(r.costCodes);
          setCostCode((cur) => cur || r.costCodes[0]?.code || "");
        })
        .catch(() => setCostCodes([]));
      const inv = await api<{ invoices: InvoiceRow[] }>(`/api/jobs/${id}/invoices`);
      setInvoices(inv.invoices);
      setContractInfo(await api<JobContract>(`/api/jobs/${id}/change-orders`));
      // .catch(null): a 403 here is a normal, expected answer for most seats,
      // not an error the page should surface.
      setProfit(await api<JobProfitCard>(`/api/jobs/${id}/profit`).catch(() => null));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.push("/login");
      } else setError("Couldn't load this job.");
    }
  }, [id, router]);

  async function issueInvoice() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/jobs/${id}/invoices`, {
        method: "POST",
        json: {
          subtotalCents: Math.round(Number(invAmount) * 100),
          retainageBps: Math.round(Number(invRetainage || "0") * 100),
          issuedOn: new Date().toISOString().slice(0, 10),
          memo: invMemo.trim() || undefined,
        },
      });
      setInvAmount("");
      setInvMemo("");
      await load();
    } catch {
      setError("Couldn't issue the invoice — check the amount.");
    } finally {
      setBusy(false);
    }
  }

  async function payInvoice(inv: InvoiceRow) {
    const remaining = inv.dueNowCents - inv.paidCents;
    if (remaining <= 0) return;
    setBusy(true);
    try {
      await api(`/api/invoices/${inv.id}/payments`, {
        method: "POST",
        json: {
          amountCents: remaining,
          method: "manual",
          receivedOn: new Date().toISOString().slice(0, 10),
        },
      });
      await load();
    } catch {
      setError("Couldn't record that payment.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  async function addCost() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/jobs/${id}/costs`, {
        method: "POST",
        json: {
          costCode,
          kind,
          amountCents: Math.round(Number(amount) * 100),
          occurredOn: new Date().toISOString().slice(0, 10),
          memo: memo || undefined,
        },
      });
      setAmount("");
      setMemo("");
      await load();
    } catch {
      setError("Couldn't save that cost — check the amount.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadReceipt(file: File) {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", "receipt");
      const res = await fetch(`/api/jobs/${id}/attachments`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error("upload failed");
      await load();
    } catch {
      setError("Upload didn't work — photos need a connection.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Draft a change order.
   *
   * `centsFromInput` rather than `Number(x) * 100`: the amount is money, and
   * parseFloat("11.29") * 100 is 1128.9999… — the exact drift the rest of this
   * system is integer-cents to avoid.
   */
  async function addChangeOrder() {
    const cents = centsFromInput(coAmount);
    if (cents === null || cents === 0) {
      setError("Put a real amount on the change order.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/api/jobs/${id}/change-orders`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        json: {
          title: coTitle.trim(),
          reason: coReason.trim(),
          lines: [
            {
              description: coTitle.trim(),
              qtyX100: 100,
              // A deduct is a negative unit price, not a separate concept —
              // one code path all the way down to the ledger.
              unitPriceCents: coDeduct ? -cents : cents,
            },
          ],
        },
      });
      setCoTitle("");
      setCoReason("");
      setCoAmount("");
      setCoDeduct(false);
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "deduct_exceeds_contract"
          ? "That deduct is bigger than the whole contract."
          : "Couldn't save that change order.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function decideCo(coId: string, body: Record<string, unknown>, ok: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/change-orders/${coId}`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        json: body,
      });
      setNote(ok);
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "change_order_already_decided"
          ? "That one has already been decided."
          : e instanceof ApiError
            ? e.message
            : "That didn't work — try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: string) {
    setBusy(true);
    try {
      await api(`/api/jobs/${id}/status`, {
        method: "POST",
        json:
          status === "complete"
            ? { status, completedOn: new Date().toISOString().slice(0, 10) }
            : { status },
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  // Inside AppShell now. This used to early-return into `main.shell`, which
  // dropped the sidebar and topbar and then snapped them back — on the screen
  // a tech opens most often, on the worst connection in the company.
  if (!s) {
    return (
      <AppShell title="Job">
        {showSkeleton && <PageSkeleton kind="detail" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  const contract = Number(s.job.contract_cents);
  const leftToSpend = Number(s.job.budget_cents) - s.costTotalCents;

  return (
    <AppShell title="Job">

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="pill">{s.job.job_type}</span>
        <span className="pill">{s.job.status}</span>
        {s.job.claim_number && (
          <span className="pill">
            claim {s.job.claim_number} · {s.job.carrier}
          </span>
        )}
      </div>

      {profit && (
        <div className="card">
          <div className="row">
            <div className="grow">
              <div className="muted">Billed</div>
              <div className="big">{dollars(profit.profit.billedCents)}</div>
            </div>
            <div className="grow">
              <div className="muted">Cost so far</div>
              <div className="big">{dollars(profit.profit.totalCostsCents)}</div>
            </div>
            <div className="grow">
              <div className="muted">
                {profit.profit.billedProfitCents < 0 ? "Lost" : "Made"}
              </div>
              <div
                className="big"
                style={{
                  color:
                    profit.profit.billedProfitCents < 0 ? "var(--danger)" : "var(--brand)",
                }}
              >
                {dollars(Math.abs(profit.profit.billedProfitCents))}
              </div>
            </div>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>{profit.explain}</p>
        </div>
      )}

      {s.depreciationNudge && (
        <div className="banner">
          <strong>Don&apos;t leave money behind:</strong> this insurance job is
          finished but the held-back depreciation hasn&apos;t been invoiced.
          If you don&apos;t invoice it, the insurance company keeps it.
        </div>
      )}

      <div className="card">
        <div className="row">
          <div className="grow">
            <div className="muted">Contract</div>
            <div className="big">{dollars(contract)}</div>
          </div>
          <div className="grow">
            <div className="muted">Costs so far</div>
            <div className="big">{dollars(s.costTotalCents)}</div>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {Number(s.job.budget_cents) > 0
            ? leftToSpend >= 0
              ? `You have ${dollars(leftToSpend)} of budget left on this job.`
              : `Careful — this job is ${dollars(-leftToSpend)} over its budget.`
            : "Set a budget to see how much you have left to spend."}
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Add a cost</h2>
        <div className="row">
          <div className="grow">
            <label htmlFor="amt">Amount ($)</label>
            <input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="842.00" />
          </div>
          <div className="grow">
            <label htmlFor="kind">What kind?</label>
            <select id="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="material">Materials</option>
              <option value="labor">Labor</option>
              <option value="sub">Subcontractor</option>
              <option value="equipment">Equipment</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="grow">
            <label htmlFor="code">Cost code</label>
            <CostCodeSelect
              id="code"
              costCodes={costCodes}
              value={costCode}
              onChange={setCostCode}
              onKind={setKind}
            />
          </div>
        </div>
        <label htmlFor="memo">Note (optional)</label>
        <input id="memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="shingles — SRS" />
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={addCost} disabled={busy || !amount}>
            Save cost
          </button>
          <label
            className="pill"
            style={{ cursor: "pointer", padding: "10px 14px" }}
          >
            📷 Add receipt photo
            <input
              type="file"
              accept="image/*,application/pdf"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadReceipt(f);
              }}
            />
          </label>
        </div>
      </div>

      {s.attachments.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Receipts & photos</h2>
          {s.attachments.map((a) => (
            <div key={a.id} className="row" style={{ padding: "4px 0" }}>
              <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">
                {a.originalName ?? a.kind}
              </a>
              <span className="muted">{a.kind}</span>
            </div>
          ))}
        </div>
      )}

      {/* ------------------------------------------------- change orders */}
      {contractInfo && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Change orders</h2>
          <p className="muted" style={{ marginTop: 0 }}>{contractInfo.explain}</p>

          {contractInfo.changeOrders.map((co) => (
            <div key={co.id} className="row" style={{ padding: "8px 0", alignItems: "center" }}>
              <div className="grow">
                <strong>CO #{co.coNo} · {co.title}</strong>
                <div className="muted" style={{ fontSize: "0.85rem" }}>
                  {/* Direction in words. A minus sign in a list of money is
                      something an owner has to stop and decode. */}
                  {co.totalCents >= 0 ? "adds " : "takes off "}
                  {dollars(Math.abs(co.totalCents))}
                  {co.reason ? ` · ${co.reason}` : ""}
                  {co.status === "approved" && co.approvedVia
                    ? ` · approved by the ${co.approvedVia}`
                    : ""}
                </div>
              </div>
              <span className="pill">{co.status}</span>
              {co.status === "draft" && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void decideCo(co.id, { action: "send" },
                      "Sent — they can approve it from their portal.")
                  }
                >
                  Send to customer
                </button>
              )}
              {(co.status === "draft" || co.status === "sent") && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void decideCo(co.id, { action: "approve" },
                      "Approved — the contract moved.")
                  }
                >
                  They said yes
                </button>
              )}
            </div>
          ))}

          <div className="row" style={{ marginTop: 10 }}>
            <label htmlFor="co-title" className="sr-only">What changed</label>
            <input id="co-title" placeholder="What changed (e.g. extra return duct)"
                   value={coTitle} onChange={(e) => setCoTitle(e.target.value)}
                   style={{ minWidth: 240 }} />
            <label htmlFor="co-amt" className="sr-only">Amount</label>
            <input id="co-amt" placeholder="$0.00" value={coAmount} inputMode="decimal"
                   onChange={(e) => setCoAmount(e.target.value)} style={{ maxWidth: 120 }} />
            <button className="chip" aria-pressed={coDeduct} onClick={() => setCoDeduct(!coDeduct)}
                    title="A credit back to the customer for work removed from the job">
              {coDeduct ? "− Deduct" : "+ Add"}
            </button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <label htmlFor="co-why" className="sr-only">Why</label>
            <input id="co-why" value={coReason} onChange={(e) => setCoReason(e.target.value)}
                   placeholder="Why — the sentence that settles arguments at final billing"
                   style={{ flex: 1, minWidth: 260 }} />
            <button disabled={busy || !coTitle.trim() || !coAmount.trim()}
                    onClick={() => void addChangeOrder()}>
              Draft it
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ marginTop: 0 }}>Invoices & payments</h2>
          <Link href={`/jobs/${id}/estimate`} className="pill" style={{ padding: "8px 14px", textDecoration: "none" }}>
            📕 Build estimate
          </Link>
        </div>
        {invoices.length === 0 && (
          <p className="muted">Nothing billed yet on this job.</p>
        )}
        {invoices.map((inv) => (
          <div key={inv.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
            <div className="grow">
              <strong>Invoice #{inv.invoiceNo}</strong>{" "}
              <span className="pill">{inv.status}</span>
              <div className="muted">
                {dollars(inv.subtotalCents)} + tax {dollars(inv.taxCents)}
                {inv.retainageCents > 0 && <> · {dollars(inv.retainageCents)} held back until the end</>}
                {" · paid "}{dollars(inv.paidCents)} of {dollars(inv.dueNowCents)} due now
              </div>
            </div>
            {inv.paidCents < inv.dueNowCents && (
              <button className="secondary" disabled={busy} onClick={() => void payInvoice(inv)}>
                Record payment
              </button>
            )}
          </div>
        ))}
        <div className="row" style={{ marginTop: 10 }}>
          <div className="grow">
            <label htmlFor="invamt">Bill amount ($, before tax)</label>
            <input id="invamt" inputMode="decimal" value={invAmount} onChange={(e) => setInvAmount(e.target.value)} placeholder="10000" />
          </div>
          <div>
            <label htmlFor="invret">Held back (%)</label>
            <input id="invret" inputMode="decimal" value={invRetainage} onChange={(e) => setInvRetainage(e.target.value)} style={{ width: 90 }} />
          </div>
        </div>
        <label htmlFor="invmemo">What it&apos;s for (optional, the customer reads this)</label>
        <input
          id="invmemo"
          value={invMemo}
          onChange={(e) => setInvMemo(e.target.value.slice(0, 500))}
          placeholder="Replaced the rooftop unit and rebuilt the return duct"
        />
        {/* One style only. An invoice line does not need a "friendly" option. */}
        <PolishBox
          text={invMemo}
          surface="invoice_memo"
          showTone={false}
          disabled={busy}
          label="✨ Say it plainer"
          onUse={setInvMemo}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={issueInvoice} disabled={busy || !invAmount}>
            Send invoice
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Tax is added automatically from your state&apos;s rules. Card payments
          arrive once Stripe keys are set up — checks and bank payments work now.
        </p>
      </div>

      {/* Deliberately ABOVE the status card: the crew fills the checklist,
          THEN marks the job done. With the completion gate switched on, the
          status buttons below refuse until the required forms are finished —
          so the thing that unblocks them has to be the thing they just
          scrolled past. */}
      <JobForms jobId={id} />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Job status</h2>
        <div className="row">
          {STATUSES.map((st) => (
            <button
              key={st}
              className={st === s.job.status ? undefined : "secondary"}
              disabled={busy || st === s.job.status}
              onClick={() => void setStatus(st)}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {/* One live region, so a screen reader hears the outcome of an action
          that changed the contract rather than watching a number move. */}
      <div role="status" aria-live="polite">
        {note && <p className="gain">{note}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </AppShell>
  );
}
