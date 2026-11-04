import "server-only";
import type { PoolClient } from "pg";
import type { TenantScope } from "@/lib/db/tenant";
import type { ScopeRequirements } from "@/modules/auth-tenancy";
import { resolveBankTxnTx, type ResolveAction } from "@/modules/bank-rec";
import { createBillTx, ensureVendorTx } from "@/modules/purchasing-ap";
import { postWorkerWeekTx } from "@/modules/workforce";
import { createStockPoTx } from "@/modules/inventory";
import { assignAppointmentTx } from "@/modules/scheduling-dispatch";
import { bookIntakeTx, unbookIntakeTx } from "@/modules/intake";
import { createReviewRequestTx, recordDunningTx } from "@/modules/crm";
import { sendOutreachTx } from "@/modules/prospecting";

// The CLOSED action-kind registry. An action kind not in this map cannot be
// proposed, approved, or executed — there is no dynamic registration path.
// Each kind names its owning agent (anti-spoof: agent A cannot propose
// agent B's kinds) and its executor, which runs server-side with the SAME
// authz as the REST routes (executors re-derive everything from scope).

export interface ExecutorContext {
  scope: TenantScope;
  client: PoolClient;
  actionId: string;
}

export interface KindSpec {
  owner: string; // owning agent_key
  /** Money-movement kinds NEVER auto-execute, even in auto mode. */
  alwaysHitl: boolean;
  /**
   * The authz an APPROVER must hold — identical to the equivalent REST route.
   *
   * Without this the approval gate was a privilege-escalation path: a viewer
   * or a zero-wall staff member could approve a queued bank.categorize or
   * ap.billDraft card and post straight to the general ledger, while the
   * direct REST route refused them 403. The comment above this block claimed
   * executors ran "with the SAME authz as the REST routes"; nothing enforced
   * it. Now the registry states it and the gate checks it.
   */
  requires: ScopeRequirements;
  /**
   * ⛔ Which payload keys a human approver may CHANGE before approving.
   *
   * `decide({type:"revise", edit})` merges `edit` over the payload and
   * executes the result. The edit was typed as an open record, so an approver
   * could overwrite ANY key — including the ids that decide WHICH invoice gets
   * dunned or WHICH transaction gets categorised. That is not a privilege
   * escalation (the approver already holds the kind's authz and could do the
   * same thing through the REST route) but it is an AUDIT hole: the stored
   * `payload` still names the original record, and a reviewer reading it sees
   * a different action than the one that ran.
   *
   * So the capability is opt-in per kind and closed by default. Omit this and
   * the kind accepts NO edits — revise returns 422. List only the fields a
   * person is genuinely meant to reword, never the ones that choose a target.
   */
  editable?: readonly string[];
  /** Deterministic summary template from the payload (used when a drafted
   *  summary fails the figure firewall, and as the DISABLE_LLM default). */
  template: (payload: Record<string, unknown>) => string;
  execute: (ctx: ExecutorContext, payload: Record<string, unknown>) => Promise<unknown>;
  undo?: (ctx: ExecutorContext, payload: Record<string, unknown>) => Promise<unknown>;
}

// ---------------------------------------------------------------- echo
// The proving agent (gate tests + live smoke): writes a harmless event.
const echoWrite: KindSpec = {
  owner: "echo",
  alwaysHitl: false,
  requires: { roles: ["owner", "admin"] },
  template: (p) => `Echo: write a note saying "${String(p.note ?? "")}"`,
  execute: async ({ scope, client }, payload) => {
    await client.query(
      `INSERT INTO events (tenant_id, name, subject_type, actor_uid, payload)
       VALUES ($1, 'echo', 'note', $2, $3)`,
      [scope.tenantId, `agent:echo`, JSON.stringify({ note: payload.note ?? "" })],
    );
    return { written: true };
  },
  undo: async ({ scope, client }, payload) => {
    await client.query(
      `INSERT INTO events (tenant_id, name, subject_type, actor_uid, payload)
       VALUES ($1, 'echo_undone', 'note', $2, $3)`,
      [scope.tenantId, `agent:echo`, JSON.stringify({ note: payload.note ?? "" })],
    );
    return { undone: true };
  },
};

// A money-ish kind for proving ALWAYS_HITL semantics before real ones land
// in S11 (bank.categorize, ledger.post, ...).
const echoMoney: KindSpec = {
  owner: "echo",
  alwaysHitl: true,
  requires: { roles: ["owner", "admin"], departments: ["financials"] },
  template: (p) =>
    `Echo (money): pretend to move ${String(p.amount ?? "0")} cents — always needs a human.`,
  execute: async ({ scope, client }, payload) => {
    await client.query(
      `INSERT INTO events (tenant_id, name, subject_type, actor_uid, payload)
       VALUES ($1, 'echo_money', 'note', $2, $3)`,
      [scope.tenantId, `agent:echo`, JSON.stringify({ amountCents: payload.amount ?? 0 })],
    );
    return { written: true };
  },
};

// ----------------------------------------------------------- financials
// The Financial agent's one kind: categorize a bank For-Review item. It
// MOVES MONEY (posts a balanced GL entry), so it is ALWAYS_HITL — the card
// never executes without a human, in any mode. The payload is flat so a
// human revise produces readable CIPHER diffs ("prefer accountCode=…").
const dollars = (cents: number) => {
  const abs = Math.abs(cents);
  return `$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
};

function toResolveAction(p: Record<string, unknown>): ResolveAction {
  const action = String(p.action);
  if (action === "expense") {
    return { type: "expense", accountCode: String(p.accountCode), remember: true };
  }
  if (action === "job-cost") {
    return {
      type: "job-cost",
      jobId: String(p.jobId),
      costCode: String(p.costCode ?? "4100"),
      kind: (p.kind as "labor" | "material" | "sub" | "equipment" | "other") ?? "material",
      remember: true,
    };
  }
  if (action === "personal") return { type: "personal" };
  return { type: "exclude" };
}

const bankCategorize: KindSpec = {
  owner: "financials",
  alwaysHitl: true,
  // mirrors /api/bank/txns/[id]/resolve
  requires: { departments: ["financials"] },
  template: (p) => {
    const amt = dollars(Number(p.amountCents ?? 0));
    const desc = String(p.description ?? "this charge");
    const when = String(p.postedOn ?? "");
    const action = String(p.action);
    if (action === "personal") {
      return `This ${amt} charge ("${desc}", ${when}) looks personal. OK to record it as money you took out — never touching profit or any job?`;
    }
    if (action === "job-cost") {
      return `This ${amt} to "${desc}" on ${when} looks like job materials. Put it on the job as a cost?`;
    }
    if (action === "exclude") {
      return `"${desc}" (${amt}, ${when}) doesn't look like yours. Leave it out of the books?`;
    }
    return `"${desc}" (${amt} on ${when}) isn't on any job. File it as a business expense under account ${String(p.accountCode ?? "")}?`;
  },
  execute: async ({ scope, client }, payload) => {
    return resolveBankTxnTx(client, scope, String(payload.txnId), toResolveAction(payload));
  },
};

// ------------------------------------------------------------ documents
// The Documents agent's kind: draft an AP bill from a received PO (later:
// from an OCR'd receipt/bill, once the bounded vision helper exists).
// Creates a bill AND posts to the ledger -> ALWAYS_HITL, no exceptions.
const apBillDraft: KindSpec = {
  owner: "documents",
  alwaysHitl: true,
  // mirrors /api/bills
  requires: { departments: ["financials"] },
  template: (p) =>
    `PO for "${String(p.vendorName ?? "")}" on job #${String(p.jobNo ?? "?")} arrived (${dollars(
      Number(p.amountCents ?? 0),
    )}). Enter the bill so it shows in what you owe?`,
  execute: async ({ scope, client }, payload) => {
    const vendorId = await ensureVendorTx(client, scope, String(payload.vendorName ?? "Unknown vendor"));
    const billId = await createBillTx(client, scope, {
      vendorId,
      issuedOn: String(payload.issuedOn),
      memo: String(payload.description ?? ""),
      poId: String(payload.poId),
      lines: [
        {
          amountCents: Number(payload.amountCents),
          jobId: String(payload.jobId),
          costCode: String(payload.costCode ?? "4100"),
          costKind: "material",
          description: String(payload.description ?? ""),
        },
      ],
    });
    return { billId };
  },
};

// ------------------------------------------------------------- workforce
// The Workforce agent's kind: post one worker's completed week of time as
// burdened labor. The executor RECOMPUTES the OT split and burden from the
// database at execution time — the card's figures are a preview, the fresh
// ground truth is what posts. Payroll-adjacent money -> ALWAYS_HITL.
const hrs = (x100: number) => (x100 / 100).toFixed(x100 % 100 === 0 ? 0 : 2);

const timePostWeek: KindSpec = {
  owner: "workforce",
  alwaysHitl: true,
  // mirrors /api/workforce/post-week
  requires: { roles: ["owner", "admin"], departments: ["hr"] },
  template: (p) => {
    const ot = Number(p.otHoursX100 ?? 0);
    const jobs = Array.isArray(p.jobNos) ? (p.jobNos as number[]) : [];
    return (
      `${String(p.workerName ?? "A worker")} logged ${hrs(Number(p.totalHoursX100 ?? 0))} hours` +
      (ot > 0 ? ` (${hrs(ot)} overtime)` : "") +
      ` the week of ${String(p.weekStart ?? "")}` +
      (jobs.length > 0 ? ` on job${jobs.length === 1 ? "" : "s"} #${jobs.join(", #")}` : "") +
      `. Post ${dollars(Number(p.totalCents ?? 0))} of burdened labor to the job${jobs.length === 1 ? "" : "s"}?`
    );
  },
  execute: async ({ scope, client }, payload) => {
    return postWorkerWeekTx(
      client,
      scope,
      String(payload.workerId),
      String(payload.weekStart),
    );
  },
};

// ------------------------------------------------------------- inventory
// The Restocker's kind: draft a stock PO when an item hits its reorder
// point. A PO commits real spend -> ALWAYS_HITL.
const inventoryReorder: KindSpec = {
  owner: "inventory",
  alwaysHitl: true,
  requires: { departments: ["financials"] },
  template: (p) => {
    const qty = Number(p.qtyX100 ?? 0) / 100;
    const onHand = Number(p.onHandX100 ?? 0) / 100;
    return (
      `${String(p.itemName ?? "An item")} is down to ${onHand} ${String(p.unit ?? "ea")} ` +
      `(reorder point ${Number(p.reorderPointX100 ?? 0) / 100}). ` +
      `Order ${qty} more from ${String(p.vendorName ?? "your vendor")} at about ` +
      `${dollars(Number(p.unitCostCents ?? 0))} each?`
    );
  },
  execute: async ({ scope, client }, payload) => {
    return createStockPoTx(client, scope, {
      itemId: String(payload.itemId),
      qtyX100: Number(payload.qtyX100),
      vendorName: String(payload.vendorName ?? "Preferred vendor"),
      unitCostCents: Number(payload.unitCostCents),
    });
  },
};

// -------------------------------------------------------------- dispatch
// The Dispatcher's kind: assign an open appointment to a worker. NO money
// moves -> the first non-HITL kind (auto mode executes) and UNDOABLE
// (undo = unassign). High confidence lowers friction; the human can always
// reassign on the board.
const dispatchAssign: KindSpec = {
  owner: "dispatch",
  alwaysHitl: false,
  requires: { roles: ["owner", "admin", "staff"] },
  template: (p) =>
    `Send ${String(p.workerName ?? "someone")} to job #${String(p.jobNo ?? "?")} ` +
    `(${String(p.jobName ?? "")}) on ${String(p.day ?? "")}? Least booked that day.`,
  execute: async ({ client }, payload) => {
    return assignAppointmentTx(client, String(payload.appointmentId), String(payload.workerId));
  },
  undo: async ({ client }, payload) => {
    return assignAppointmentTx(client, String(payload.appointmentId), null);
  },
};

// --------------------------------------------------------------- booking
// The Receptionist's kind: book an intake request into a REAL open slot.
// Outward-facing but no money and fully undoable -> not always-HITL.
const intakeBook: KindSpec = {
  owner: "booking",
  alwaysHitl: false,
  requires: { roles: ["owner", "admin", "staff"] },
  template: (p) =>
    `Book ${String(p.name ?? "the caller")} (${String(p.description ?? "estimate visit").slice(0, 60) || "estimate visit"}) ` +
    `for the ${String(p.window ?? "next open")} slot on ${String(p.date ?? "")}? ` +
    `That time is genuinely open.`,
  execute: async ({ scope, client }, payload) => {
    return bookIntakeTx(client, scope, String(payload.intakeId), {
      startsAt: String(payload.startsAt),
      endsAt: String(payload.endsAt),
    });
  },
  undo: async ({ client }, payload) => {
    await unbookIntakeTx(client, String(payload.intakeId));
    return { unbooked: true };
  },
};

// -------------------------------------------------------------------- crm
// The Front Desk's kinds: outward-facing customer messages. ALWAYS_HITL —
// nothing reaches a customer without the owner's yes. Approving returns
// the exact text to send (SMS/email transport joins when keys land).
const crmReviewRequest: KindSpec = {
  owner: "crm",
  alwaysHitl: true,
  requires: { roles: ["owner", "admin", "staff"] },
  editable: ["message"],
  template: (p) =>
    `Job #${String(p.jobNo ?? "?")} (${String(p.jobName ?? "")}) is done and paid. ` +
    `Ask ${String(p.customerName ?? "the customer")} for a review?`,
  execute: async ({ scope, client }, payload) => {
    return createReviewRequestTx(
      client,
      scope,
      String(payload.jobId),
      String(payload.customerId),
      // Undefined unless a human reworded it; the default text is composed
      // inside the store from the tenant and customer, which is where it
      // belongs — this is an override, not a required argument.
      payload.message === undefined ? undefined : String(payload.message),
    );
  },
};

const arDunningDraft: KindSpec = {
  owner: "crm",
  alwaysHitl: true,
  // dunning speaks to a customer about money in the company name
  requires: { roles: ["owner", "admin"], departments: ["financials"] },
  // The words, and ONLY the words. Not invoiceId — retargeting which invoice
  // gets chased is a different action, not a revision of this one.
  editable: ["message"],
  template: (p) =>
    `Invoice #${String(p.invoiceNo ?? "?")} for ${String(p.customerName ?? "a customer")} has ` +
    `${dollars(Number(p.openCents ?? 0))} open after ${String(p.daysOld ?? "?")} days. ` +
    `Send the friendly reminder below?

"${String(p.message ?? "")}"`,
  execute: async ({ scope, client }, payload) => {
    return recordDunningTx(client, scope, String(payload.invoiceId), String(payload.message ?? ""));
  },
};

// ------------------------------------------------------------------ sales
// The Sales agent's kind: a win-back text to a customer the signals engine
// ranked worth a call. Outward-facing — ALWAYS_HITL, nothing reaches a
// customer without the owner's yes. Approving sends it (best-effort SMS,
// then email) and snoozes the triggering signal for 30 days.
const salesOutreachDraft: KindSpec = {
  owner: "sales",
  alwaysHitl: true,
  // mirrors /api/sales/targets
  requires: { roles: ["owner", "admin", "staff"] },
  // The words, and ONLY the words — which customer gets reached, and why,
  // is the action itself, not a revision of it.
  editable: ["message"],
  template: (p) =>
    `${String(p.customerName ?? "A customer")} looks worth a call this week ` +
    `(${String(p.reason ?? "signals from your own book")}). Send the text below?

"${String(p.message ?? "")}"`,
  execute: async ({ scope, client }, payload) => {
    return sendOutreachTx(client, scope, {
      customerId: String(payload.customerId),
      signalKey: String(payload.signalKey ?? ""),
      message: String(payload.message ?? ""),
    });
  },
};

export const KINDS: Record<string, KindSpec> = {
  "echo.write": echoWrite,
  "echo.money": echoMoney,
  "bank.categorize": bankCategorize,
  "ap.billDraft": apBillDraft,
  "time.postWeek": timePostWeek,
  "inventory.reorder": inventoryReorder,
  "dispatch.assign": dispatchAssign,
  "intake.book": intakeBook,
  "crm.reviewRequest": crmReviewRequest,
  "ar.dunningDraft": arDunningDraft,
  "sales.outreachDraft": salesOutreachDraft,
};

export const AGENT_KEYS = ["echo", "financials", "documents", "workforce", "inventory", "dispatch", "booking", "crm", "sales"] as const;

/** Master kill switch + optional narrowing allowlist, both env-driven. */
export function actionsEnabled(): boolean {
  return process.env.ACTIONS_ENABLED !== "0";
}

export function kindAllowed(kind: string): boolean {
  if (!(kind in KINDS)) return false;
  const allow = process.env.AGENT_KIND_ALLOWLIST;
  if (!allow) return true;
  return allow.split(",").map((s) => s.trim()).includes(kind);
}

