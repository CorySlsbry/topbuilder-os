import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { CardError, chargeSavedCard, rolloverDue } from "@/modules/agreements";
import { recordPayment } from "@/modules/sales-invoicing";
import { DEFAULT_POSTING_ACCOUNTS } from "@/modules/field-ops";
import { withTenant } from "@/lib/db/tenant";
import { runDailyNotifications } from "@/modules/comms";
import { runIntakeAgent } from "@/modules/intake";
import { runCrmAgent } from "@/modules/crm";
import { runDispatchAgent } from "@/modules/scheduling-dispatch";
import { runFinancialAgent } from "@/modules/financial-agent";
import { runInventoryAgent } from "@/modules/inventory";
import { runDocumentsAgent } from "@/modules/purchasing-ap";
import { runWorkforceAgent } from "@/modules/workforce";
import { listConnections, syncFeed } from "@/modules/bank-rec";
import { geocodePending, runSalesAgent } from "@/modules/prospecting";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The daily heartbeat — Cloud Scheduler hits this once a morning (America/
 * Phoenix) with the shared secret. Everything here is IDEMPOTENT by design:
 * rollovers lock and re-check period_end, notifications dedupe on the log's
 * ref, so a retried or doubled invocation does nothing twice. That is the
 * entire contract for money on a timer.
 *
 * Per tenant, in order:
 *   1. agreement rollovers — lapsed periods release their deferred stub,
 *      renewals bill the next period
 *   2. (autopay charges for renewals are returned by rolloverDue; charging
 *      goes live with the Stripe card-on-file flow — logged until then)
 *   3. appointment reminders for tomorrow + membership visit-due nudges
 *
 * Auth: constant-time compare against CRON_SECRET. No session, no tenant
 * cookie — this is a machine principal, scoped tenant-by-tenant below, the
 * same trust shape as the Stripe webhook.
 */
export const POST = route(async (req: NextRequest) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return errorResponse(503, "cron_not_configured");
  const given = req.headers.get("x-cron-secret") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return errorResponse(401, "unauthorized");
  }

  const today = new Date().toISOString().slice(0, 10);
  // app.cron_tenants() — SECURITY DEFINER. A machine principal has no uid,
  // so the member-read policy on tenants correctly returns it nothing; the
  // definer grants exactly ids+names, and every downstream read is scoped
  // per tenant below.
  const tenants = await getPool().query<{ id: string; name: string }>(
    "SELECT id, name FROM app.cron_tenants()",
  );

  const report: Record<string, unknown>[] = [];
  for (const t of tenants.rows) {
    // ⛔ ONE principal per tenant, built BEFORE anything runs. This used to be
    // a bare `{ uid, tenantId }` here and a full principal ninety lines below
    // for the agents alone — two scopes for one tenant, and everything reached
    // by the first one was silently crippled. See cronPrincipal().
    const scope = await cronPrincipal(t.id);
    try {
      const roll = await rolloverDue(scope, today);

      // Autopay: charge each renewal's saved card AFTER its rollover
      // transaction committed. The idempotency key is derived from the
      // invoice, so a crashed-and-retried cron cannot double-charge — Stripe
      // returns the same payment intent and recordPayment dedupes on it.
      let charged = 0;
      let declined = 0;
      for (const due of roll.autopayDue) {
        try {
          const { paymentIntentId } = await chargeSavedCard(scope, {
            paymentMethodId: due.paymentMethodId,
            amountCents: due.amountCents,
            description: `Membership renewal ${due.invoiceId}`,
            idempotencyKey: `agr-renewal-${due.invoiceId}`,
          });
          await recordPayment(scope, {
            invoiceId: due.invoiceId,
            amountCents: due.amountCents,
            method: "stripe",
            reference: paymentIntentId,
            receivedOn: today,
            accounts: DEFAULT_POSTING_ACCOUNTS,
          });
          charged++;
        } catch (err) {
          if (err instanceof CardError && err.status === 402) {
            // Declined: the member is past due, the invoice stays open, a
            // human follows up. Nothing retries in a loop against a dead
            // card.
            await withTenant(scope, (c) =>
              c.query(`UPDATE agreements SET status = 'past_due' WHERE id = $1`, [
                due.agreementId,
              ]),
            );
            declined++;
          } else {
            console.error(`[cron] autopay charge failed (${due.agreementId}):`, err);
            declined++;
          }
        }
      }

      const notif = await runDailyNotifications(scope, t.name);

      // ⛔ BEFORE THE AGENTS, DELIBERATELY. A connected bank feed pulled
      // transactions only when somebody opened /bank and pressed Sync — so
      // the one part of the product that is supposed to work while the owner
      // is on a roof was the part that required them to be at a desk. The
      // financial agent then ran against yesterday's transactions and
      // proposed nothing, which reads as "nothing to do" rather than
      // "nothing was fetched".
      //
      // Idempotent by construction: the provider's transaction id is unique
      // per tenant (0055), so an overlapping window inserts nothing. That is
      // what makes a daily re-pull safe.
      const feeds = await syncFeeds(scope);

      // Geocode the book's addresses — after feeds (unrelated), before the
      // agents (a future sales agent reads the pins). Idempotent: only
      // 'pending' rows are attempted, so a settled book costs zero calls.
      let geo = { attempted: 0, ok: 0, failed: 0, deferred: 0 };
      try {
        geo = await geocodePending(scope);
      } catch (err) {
        console.error(`[cron] geocoding failed for tenant ${t.id}:`, err);
      }

      // ⛔ THE HEARTBEAT. Every one of these agents was written, tested,
      // idempotent and budget-capped — and NONE of them ran unless somebody
      // opened the right screen and tapped a button. A product whose whole
      // promise is "you don't open the laptop after dinner" was requiring
      // exactly that to produce a single card.
      //
      // Nothing about the trust model changes here. Each kind's own policy
      // (off / ask-first / auto) still decides, ALWAYS_HITL kinds still
      // never auto-execute, propose() still dedupes on its idempotency key
      // so a re-run creates nothing, and checkBudget still caps spend per
      // tenant per day. This only decides WHEN they get the chance.
      //
      // ⛔ The agents need a MACHINE PRINCIPAL, not the bare tenant scope.
      // propose() runs the kind's own authz (the fix that closed the
      // weak-approver hole), and a scope with no role and no departments
      // fails every kind that names either — which silently turned the
      // nightly run into "0 proposed" with role_forbidden in the report.
      // The cron proposes ON THE TENANT'S BEHALF: HITL kinds still wait for
      // a human whose OWN authz is re-checked at decide(), and auto kinds
      // executing under this principal is exactly what "auto" means.
      const agents = await runAgents(scope);

      report.push({
        tenant: t.name,
        renewed: roll.renewed,
        closed: roll.closed,
        autopayCharged: charged,
        autopayDeclined: declined,
        reminders: notif.reminders,
        visitNudges: notif.visitNudges,
        geocoded: geo.ok,
        geocodeFailed: geo.failed,
        feedsSynced: feeds.synced,
        feedTxnsNew: feeds.newTxns,
        feedsFailed: feeds.failed,
        agentsProposed: agents.proposed,
        agentsFailed: agents.failed,
      });
    } catch (err) {
      // One tenant's bad day must not stop the others' reminders.
      console.error(`[cron] tenant ${t.id} failed:`, err);
      report.push({ tenant: t.name, error: (err as Error).message });
    }
  }

  return NextResponse.json({ ranOn: today, tenants: report });
});

/**
 * The machine principal the whole nightly run acts under, for ONE tenant.
 *
 * ⛔ WHY THIS EXISTS AS A FUNCTION. The loop used to open with a bare
 * `{ uid, tenantId }` and then build a full principal ninety lines later, for
 * the agents only. Everything reached by the bare one ran with
 * `app.current_departments` set to the empty string, so every RESTRICTIVE
 * department policy evaluated FALSE and failed closed:
 *
 *   `syncFeeds` → `listConnections` reads `feed_connections`, guarded by
 *     `fc_department` (0054). Zero rows, no error. The morning report says
 *     `feedsSynced: 0` — indistinguishable from "this shop has no bank feed",
 *     which is exactly the "nothing was fetched" vs "nothing to do" confusion
 *     the comment above the feed step says this step exists to end.
 *
 *   `chargeSavedCard` reads `saved_payment_methods`, guarded by
 *     `spm_department` (0037). No row, so `CardError(404, card_not_found)`,
 *     which is not the 402 branch, so every renewal is counted `declined++`
 *     and no card is ever charged — while the renewal invoice and its revenue
 *     posting were already committed by `rolloverDue`.
 *
 * The agents were fixed for the identical reason (their comment records
 * `role_forbidden` turning the run into "0 proposed") and the fix was never
 * back-applied to its two siblings. One principal, built once, is the shape
 * that cannot drift again: there is no second scope to forget.
 *
 * `departments` is read from the tenant's own directory rather than hardcoded,
 * so a shop with custom departments gets those too. That read is itself safe
 * on a bare scope — `departments` is a directory table with no department wall
 * of its own, which is what makes bootstrapping possible at all.
 */
async function cronPrincipal(tenantId: string): Promise<{
  uid: string;
  tenantId: string;
  role: "owner";
  departments: string[];
  aal: "aal2";
}> {
  const bare = { uid: "cron:daily", tenantId };
  const departments = await withTenant(bare, async (c) => {
    const d = await c.query<{ key: string }>(`SELECT key FROM departments`);
    return d.rows.map((r) => r.key);
  });
  // The cron acts ON THE TENANT'S BEHALF: HITL kinds still wait for a human
  // whose OWN authz is re-checked at decide(), and auto kinds executing under
  // this principal is exactly what "auto" means.
  return { ...bare, role: "owner" as const, departments, aal: "aal2" as const };
}

/**
 * Pull every live bank feed for one tenant.
 *
 * Same isolation rule as runAgents below, for the same reason: one dead
 * enrollment (a customer changed their bank password overnight — routine)
 * must not stop the other accounts syncing. A FeedAuthError is a fact about
 * one connection, and `syncFeed` already records it on the row so the /bank
 * screen can show a re-connect prompt; here it is reported and stepped over.
 */
async function syncFeeds(
  scope: { uid: string; tenantId: string },
): Promise<{ synced: number; newTxns: number; failed: { institution: string; error: string }[] }> {
  const failed: { institution: string; error: string }[] = [];
  let synced = 0;
  let newTxns = 0;

  let connections;
  try {
    connections = await listConnections(scope);
  } catch (err) {
    // No connections table access, or a tenant mid-migration. Not fatal to
    // the rest of the morning.
    console.error(`[cron] listing feeds failed for tenant ${scope.tenantId}:`, err);
    return { synced, newTxns, failed };
  }

  for (const conn of connections) {
    // A disconnected or errored connection needs a human to re-authorise;
    // hammering it daily just re-fails and buries the real errors.
    if (conn.status !== "active") continue;
    try {
      const r = await syncFeed(scope, conn.id);
      synced++;
      newTxns += r.newTransactions;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      console.error(`[cron] feed sync failed (${conn.institution}):`, err);
      failed.push({ institution: conn.institution, error: message.slice(0, 200) });
    }
  }
  return { synced, newTxns, failed };
}

/**
 * Run every department agent for one tenant.
 *
 * ⛔ ONE AGENT'S BAD DAY MUST NOT COST THE OTHERS THEIR RUN. Each is caught
 * individually: an agent that is switched off throws `agent_off`, an agent
 * over its budget throws, and a genuine bug throws — and in a single
 * try/catch around all seven, the first of those silently cancels the six
 * behind it. That failure would be invisible, because the owner would simply
 * see fewer cards and have no way to know some were never attempted.
 *
 * The names are reported so a quiet morning can be diagnosed from the cron
 * log rather than guessed at.
 */
async function runAgents(
  scope: {
    uid: string;
    tenantId: string;
    role: "owner";
    departments: string[];
    aal: "aal2";
  },
): Promise<{ proposed: number; failed: { agent: string; error: string }[] }> {
  const RUNS: [string, (s: never) => Promise<{ proposed: number }>][] = [
    ["intake", runIntakeAgent as never],
    ["dispatch", runDispatchAgent as never],
    ["financials", runFinancialAgent as never],
    ["documents", runDocumentsAgent as never],
    ["inventory", runInventoryAgent as never],
    ["workforce", runWorkforceAgent as never],
    ["crm", runCrmAgent as never],
    ["sales", runSalesAgent as never],
  ];

  let proposed = 0;
  const failed: { agent: string; error: string }[] = [];

  for (const [name, run] of RUNS) {
    try {
      const r = await run(scope as never);
      proposed += r.proposed ?? 0;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // `agent_off` is a CHOICE the shop made, not a failure. Reporting it
      // as one would train everybody to ignore this list.
      if (message.includes("agent_off")) continue;
      console.error(`[cron] agent ${name} failed for tenant ${scope.tenantId}:`, err);
      failed.push({ agent: name, error: message.slice(0, 200) });
    }
  }
  return { proposed, failed };
}
