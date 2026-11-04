import { NextResponse } from "next/server";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { runCrmAgent } from "@/modules/crm";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

// Draft review asks (done + paid jobs) and friendly payment reminders
// (30+ days open). Every draft is ALWAYS_HITL — approving hands you the
// exact text; nothing is sent on its own.
export const POST = route(async () => {
  const scope = await requireScope({ roles: [...WRITE_ROLES], departments: ["financials"] });
  await assertCapability(scope, "agents");
  return NextResponse.json(await runCrmAgent(scope));
});
