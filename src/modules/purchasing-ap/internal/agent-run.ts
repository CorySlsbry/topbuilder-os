import "server-only";
import { checkBudget, finishRun, propose, startRun, type AgentActorScope } from "@/modules/agents";
import { withTenant } from "@/lib/db/tenant";
import { listReceivedPosWithoutBills } from "./store";

// The Documents agent (deterministic v1): every received PO without a bill
// becomes a plain-language card — "the materials arrived, enter the bill?"
// Creating a bill posts to the ledger, so ap.billDraft is ALWAYS_HITL.
// (OCR'd receipts/bills join this same flow when the bounded vision helper
// exists; it will only ever fill the same closed fields.)

export interface DocumentsRunReport {
  runId: string;
  scanned: number;
  proposed: number;
  duplicates: number;
}

export async function runDocumentsAgent(scope: AgentActorScope): Promise<DocumentsRunReport> {
  await checkBudget(scope);
  const runId = await startRun(scope, "documents", "manual");
  const pos = await listReceivedPosWithoutBills(scope);

  // The shop's own first cost code, not the literal "4100" this used to
  // propose on every bill draft. A purchase order carries no cost code of
  // its own (0008), so the bookkeeper picks the real one when they approve —
  // this is the starting position, and it has to be one of THEIR codes.
  const defaultCostCode = await withTenant(scope, async (c) => {
    const { rows } = await c.query<{ code: string }>(
      "SELECT code FROM cost_codes WHERE is_active ORDER BY sort_order, code LIMIT 1",
    );
    return rows[0]?.code ?? null;
  });

  let proposed = 0;
  let duplicates = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const po of pos) {
    const r = await propose(scope, {
      agentKey: "documents",
      kind: "ap.billDraft",
      payload: {
        poId: po.id,
        vendorName: po.vendorName,
        jobId: po.jobId,
        jobNo: po.jobNo,
        description: po.description,
        amountCents: po.amountCents,
        costCode: defaultCostCode,
        issuedOn: today,
      },
      figures: [po.amountCents],
      idempotencyKey: `doc:bill:${po.id}`,
      confidence: 90, // the PO itself is the evidence
      runId,
    });
    if (r.duplicate) duplicates++;
    else proposed++;
  }

  await finishRun(scope, runId, {
    ok: true,
    output: { scanned: pos.length, proposed, duplicates },
    costMicroUsd: 0,
  });
  return { runId, scanned: pos.length, proposed, duplicates };
}
