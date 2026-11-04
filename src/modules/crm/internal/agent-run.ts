import "server-only";
import { checkBudget, finishRun, propose, startRun, type AgentActorScope } from "@/modules/agents";
import { dunningMessage, overdueInvoices, reviewCandidates } from "./store";

// The Front Desk (deterministic): two outward-facing drafts, both
// ALWAYS_HITL — a message to a customer never leaves without a human yes.
//   1. review requests for completed-and-paid jobs,
//   2. friendly payment reminders for invoices open past 30 days
//      (figures verbatim; the firewall re-checks them at the gate).

export interface CrmRunReport {
  runId: string;
  reviewsProposed: number;
  dunningProposed: number;
  duplicates: number;
}

export async function runCrmAgent(scope: AgentActorScope): Promise<CrmRunReport> {
  await checkBudget(scope);
  const runId = await startRun(scope, "crm", "manual");

  const [reviews, overdue] = await Promise.all([
    reviewCandidates(scope),
    overdueInvoices(scope, 30),
  ]);

  let reviewsProposed = 0;
  let dunningProposed = 0;
  let duplicates = 0;

  for (const rv of reviews) {
    const r = await propose(scope, {
      agentKey: "crm",
      kind: "crm.reviewRequest",
      payload: {
        jobId: rv.jobId,
        jobNo: rv.jobNo,
        jobName: rv.jobName,
        customerId: rv.customerId,
        customerName: rv.customerName,
      },
      figures: [rv.jobNo],
      idempotencyKey: `review:${rv.jobId}`,
      confidence: 85,
      runId,
    });
    if (r.duplicate) duplicates++;
    else reviewsProposed++;
  }

  for (const inv of overdue) {
    const message = dunningMessage(inv);
    const r = await propose(scope, {
      agentKey: "crm",
      kind: "ar.dunningDraft",
      payload: {
        invoiceId: inv.invoiceId,
        invoiceNo: inv.invoiceNo,
        jobName: inv.jobName,
        customerName: inv.customerName,
        openCents: inv.openCents,
        daysOld: inv.daysOld,
        message,
      },
      figures: [inv.openCents, inv.invoiceNo, inv.daysOld],
      idempotencyKey: `dun:${inv.invoiceId}:${inv.openCents}`,
      confidence: 90,
      runId,
    });
    if (r.duplicate) duplicates++;
    else dunningProposed++;
  }

  await finishRun(scope, runId, {
    ok: true,
    output: { reviewsProposed, dunningProposed, duplicates },
    costMicroUsd: 0,
  });
  return { runId, reviewsProposed, dunningProposed, duplicates };
}
