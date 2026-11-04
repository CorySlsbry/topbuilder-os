import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { listRoster } from "@/modules/workforce";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/** Names + ids only — what time logging and dispatch need. Pay rates and
 *  burden live behind the HR wall on /api/workforce/workers. */
export const GET = route(async () => {
  const scope = await requireScope();
  await assertCapability(scope, "workforce");
  return NextResponse.json({ roster: await listRoster(scope) });
});
