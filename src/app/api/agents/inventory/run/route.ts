import { NextResponse } from "next/server";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { runInventoryAgent } from "@/modules/inventory";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

// Scan for items at/below their reorder point; propose one ALWAYS_HITL
// restock-PO card per item (skipping items with an open restock PO).
export const POST = route(async () => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  await assertCapability(scope, "agents");
  return NextResponse.json(await runInventoryAgent(scope));
});
