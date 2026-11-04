import { NextResponse } from "next/server";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { runSalesAgent } from "@/modules/prospecting";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

// Draft win-back outreach for the week's top targets. Every draft is
// ALWAYS_HITL — approving is what sends it; nothing reaches a customer
// on its own.
export const POST = route(async () => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  await assertCapability(scope, "agents");
  return NextResponse.json(await runSalesAgent(scope));
});
