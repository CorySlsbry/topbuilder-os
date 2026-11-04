import { NextResponse } from "next/server";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { runDispatchAgent } from "@/modules/scheduling-dispatch";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

// Propose (or in Auto mode, immediately make) least-loaded assignments for
// unassigned appointments in the next 14 days. Undoable; no money moves.
export const POST = route(async () => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  await assertCapability(scope, "agents");
  return NextResponse.json(await runDispatchAgent(scope));
});
