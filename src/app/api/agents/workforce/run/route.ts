import { NextResponse } from "next/server";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { runWorkforceAgent } from "@/modules/workforce";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

// Scan completed worker-weeks of pending time; propose one ALWAYS_HITL
// posting card per week. Mid-week time is held (posting early would split
// the overtime calculation).
export const POST = route(async () => {
  const scope = await requireScope({ roles: [...WRITE_ROLES], departments: ["hr"] });
  await assertCapability(scope, "agents");
  return NextResponse.json(await runWorkforceAgent(scope));
});
