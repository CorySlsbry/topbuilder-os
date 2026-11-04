import { NextResponse } from "next/server";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { runDocumentsAgent } from "@/modules/purchasing-ap";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

// Scan received POs without bills; propose one ALWAYS_HITL bill-draft card
// per PO. Nothing posts without a human.
export const POST = route(async () => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  await assertCapability(scope, "agents");
  return NextResponse.json(await runDocumentsAgent(scope));
});
