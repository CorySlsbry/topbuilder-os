import { NextResponse } from "next/server";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { runIntakeAgent } from "@/modules/intake";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

// Propose (or in Auto mode, make) bookings for new intake requests at the
// earliest REAL open slots. Undoable; no money moves.
export const POST = route(async () => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  await assertCapability(scope, "agents");
  return NextResponse.json(await runIntakeAgent(scope));
});
