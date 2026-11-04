import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { KINDS, listActions } from "@/modules/agents";
import { listBankTxns } from "@/modules/bank-rec";
import { listBills, listReceivedPosWithoutBills } from "@/modules/purchasing-ap";
import { listIntake } from "@/modules/intake";
import { listPendingWeeks } from "@/modules/workforce";
import { listVisits } from "@/modules/agreements";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/**
 * The approvals inbox: everything in the business waiting on a HUMAN,
 * in one place, grouped by department.
 *
 * Before this, the same work was real but scattered — helper cards on
 * /agents, bank items on /bank, unbilled POs on /purchasing, finished weeks
 * on /crew, new calls on /intake. Five tabs to answer "what needs me?", which
 * in practice means it gets answered once a day instead of continuously.
 *
 * Two kinds of item, deliberately:
 *   decide  — helper cards, actionable INLINE (approve / deny) because the
 *             decide API already enforces per-kind authz + figure firewall.
 *   link    — documents with their own screen (a bank line, a PO, a week of
 *             time). The inbox counts them and takes you THERE — the native
 *             surface has the editor, so duplicating it here would just be a
 *             second, worse editor to keep in sync.
 *
 * Visibility: a group is included only if the caller holds its department
 * (owner/admin hold all — resolveScope expands their grants). Agent cards are
 * additionally filtered by listActions' own canSeeKind, so nothing here can
 * show a payload its own route would refuse.
 */

interface InboxItem {
  type: "decide" | "link";
  id: string;
  title: string;
  detail: string;
  href: string;
  /** For decide items: the agent-action id the decide API expects. */
  actionId?: string;
  /** The registry kind, so the screen can pick the right polish surface. */
  kind?: string;
  /**
   * The words this card will actually send, when the kind says they may be
   * reworded before approval.
   *
   * ⛔ Built from the kind's OWN `editable` allowlist, never from the whole
   * payload. A dunning payload carries the customer name, the invoice number
   * and the open balance; shipping all of it to the browser so the screen can
   * pick out one field would put the rest on a page that only needs the
   * message. The same list is what `decide` enforces on the way back in, so
   * the screen cannot offer a field the gate would refuse.
   */
  editable?: Record<string, string>;
}

interface InboxGroup {
  key: string;
  name: string;
  items: InboxItem[];
}

/** Where each helper card's SOURCE document lives — the click-in target. */
const KIND_HREF: Record<string, string> = {
  "bank.categorize": "/bank",
  "ap.billDraft": "/purchasing",
  "inventory.reorder": "/stock",
  "ar.dunningDraft": "/money",
  "crm.reviewRequest": "/customers",
  "sales.outreachDraft": "/sales",
  "time.postWeek": "/crew",
  "dispatch.assign": "/dispatch",
  "intake.book": "/intake",
  "echo.write": "/agents",
  "echo.money": "/agents",
};

/** Kinds with no department requirement group by what the work IS about. */
const OWNER_GROUP: Record<string, string> = {
  dispatch: "field",
  booking: "field",
  crm: "field",
  sales: "field",
  echo: "financials",
};

export const GET = route(async () => {
  const scope = await requireScope();
  await assertCapability(scope, "agents");
  const held = new Set(scope.departments);

  const [cards, bankPending, unbilledPos, bills, intake, pendingWeeks, dueVisits] =
    await Promise.all([
      listActions(scope, "proposed"),
      held.has("financials") ? listBankTxns(scope, "pending") : [],
      held.has("financials") ? listReceivedPosWithoutBills(scope) : [],
      held.has("financials") ? listBills(scope) : [],
      held.has("field") ? listIntake(scope) : [],
      held.has("hr") ? listPendingWeeks(scope) : [],
      held.has("field") ? listVisits(scope, "due") : [],
    ]);

  const groups = new Map<string, InboxGroup>();
  const NAMES: Record<string, string> = {
    financials: "Money & books",
    field: "Field & jobs",
    hr: "People & pay",
  };
  const group = (key: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { key, name: NAMES[key] ?? key, items: [] };
      groups.set(key, g);
    }
    return g;
  };

  // Helper cards — already visibility-filtered by listActions.
  for (const a of cards) {
    const spec = KINDS[a.kind];
    const dept =
      spec?.requires.departments?.[0] ?? OWNER_GROUP[a.agentKey] ?? "field";
    const editable: Record<string, string> = {};
    for (const field of spec?.editable ?? []) {
      const value = (a.payload as Record<string, unknown>)?.[field];
      if (typeof value === "string" && value.trim()) editable[field] = value;
    }
    group(dept).items.push({
      type: "decide",
      id: `card-${a.id}`,
      actionId: a.id,
      title: a.summary,
      detail: `${a.agentKey} helper · waiting since ${a.createdAt.slice(0, 10)}`,
      href: KIND_HREF[a.kind] ?? "/agents",
      // Only present when the kind opened a field AND the payload has one.
      ...(Object.keys(editable).length > 0 ? { editable } : {}),
      // The screen needs this to pick the right polish surface. It is already
      // implied by the card's group; naming it avoids a second mapping table
      // in the browser that would drift from the registry.
      kind: a.kind,
    });
  }

  // Bank lines needing a category — the For-Review queue.
  if (bankPending.length > 0) {
    group("financials").items.push({
      type: "link",
      id: "bank-pending",
      title: `${bankPending.length} bank ${bankPending.length === 1 ? "line" : "lines"} to categorize`,
      detail: "Each needs a job or an account before the month can close.",
      href: "/bank",
    });
  }

  // Received POs with no bill yet — cost is on site but not on the books.
  for (const po of unbilledPos) {
    group("financials").items.push({
      type: "link",
      id: `po-${po.id}`,
      title: `${po.vendorName}: bill not entered for job #${po.jobNo}`,
      detail: `${po.description || "Received PO"} — enter the bill so the job cost is real.`,
      href: "/purchasing",
    });
  }

  // Bills coming due inside a week — the "don't burn the supplier" list.
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  for (const b of bills) {
    if ((b.status === "open" || b.status === "partial") && b.dueOn && b.dueOn <= soon) {
      group("financials").items.push({
        type: "link",
        id: `bill-${b.id}`,
        title: `${b.vendorName} due ${b.dueOn}`,
        detail: b.memo || b.billRef || "Open bill",
        href: `/purchasing/${b.id}`,
      });
    }
  }

  // New intake — a customer is literally waiting on a call back.
  for (const r of intake) {
    if (r.status === "new") {
      group("field").items.push({
        type: "link",
        id: `intake-${r.id}`,
        title: `${r.name || "New request"} — ${r.description || "needs scheduling"}`,
        detail: r.preferredWindow
          ? `Wants ${r.preferredWindow}. Book it onto the dispatch board.`
          : "Book it onto the dispatch board.",
        href: "/intake",
      });
    }
  }

  // Membership tune-ups coming due — the promise the customer prepaid for.
  const soon60 = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  for (const v of dueVisits) {
    if (v.dueOn <= soon60) {
      group("field").items.push({
        type: "link",
        id: `visit-${v.id}`,
        title: `${v.customerName}: ${v.planName} tune-up due ${v.dueOn.slice(0, 7)}`,
        detail: "Book it onto the board — completing it earns the deferred revenue.",
        href: "/memberships",
      });
    }
  }

  // Finished weeks not yet posted — labor cost missing from every job report.
  for (const w of pendingWeeks) {
    group("hr").items.push({
      type: "link",
      id: `week-${w.workerId}-${w.weekStart}`,
      title: `${w.workerName}: week of ${w.weekStart} ready to post`,
      detail: `${(w.totalHoursX100 / 100).toFixed(1)} hours — posting puts the labor on the jobs.`,
      href: "/crew",
    });
  }

  // Stable order: money first (it rots fastest), then field, then people.
  const order = ["financials", "field", "hr"];
  const out = [...groups.values()].sort(
    (a, b) => order.indexOf(a.key) - order.indexOf(b.key),
  );
  return NextResponse.json({ groups: out });
});
