import "server-only";
import { checkBudget, finishRun, propose, startRun, type AgentActorScope } from "@/modules/agents";
import { listLowStock } from "./store";

// The Restocker (deterministic): items at/below their reorder point (with
// no open restock PO already) become cards proposing a stock PO at the
// current moving-average cost from the preferred vendor. A PO commits real
// spend -> ALWAYS_HITL.

export interface InventoryRunReport {
  runId: string;
  scanned: number;
  proposed: number;
  duplicates: number;
}

export async function runInventoryAgent(scope: AgentActorScope): Promise<InventoryRunReport> {
  await checkBudget(scope);
  const runId = await startRun(scope, "inventory", "manual");
  const low = await listLowStock(scope);

  let proposed = 0;
  let duplicates = 0;
  for (const item of low) {
    const r = await propose(scope, {
      agentKey: "inventory",
      kind: "inventory.reorder",
      payload: {
        itemId: item.id,
        itemName: item.name,
        unit: item.unit,
        qtyX100: item.reorderQtyX100,
        unitCostCents: item.avgUnitCostCents,
        vendorName: item.preferredVendor || "Preferred vendor",
        onHandX100: item.qtyOnHandX100,
        reorderPointX100: item.reorderPointX100,
      },
      figures: [
        item.reorderQtyX100,
        item.qtyOnHandX100,
        item.reorderPointX100,
        item.avgUnitCostCents,
      ],
      idempotencyKey: `inv:reorder:${item.id}:${item.qtyOnHandX100}`,
      confidence: 85,
      runId,
    });
    if (r.duplicate) duplicates++;
    else proposed++;
  }

  await finishRun(scope, runId, {
    ok: true,
    output: { proposed, duplicates },
    costMicroUsd: 0,
  });
  return { runId, scanned: low.length, proposed, duplicates };
}
