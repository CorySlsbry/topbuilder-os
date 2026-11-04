import { NextResponse } from "next/server";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { runFinancialAgent } from "@/modules/financial-agent";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

// Scan the bank For-Review queue and propose one question card per item.
// Cards are ALWAYS_HITL — nothing posts without a human answer.
export const POST = route(async () => {
  const scope = await requireScope({ roles: [...WRITE_ROLES], departments: ["financials"] });
  await assertCapability(scope, "agents");
  return NextResponse.json(await runFinancialAgent(scope));
});
