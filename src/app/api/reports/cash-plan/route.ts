import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { getCashPlan } from "@/modules/forecast";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/**
 * The 13-week cash plan.
 *
 * Financials wall, like every other view of the shop's money position. A
 * separate route from /api/reports/forecast rather than a replacement: the old
 * forecast is a simpler, narrower answer that other things still read, and
 * two honest reports beat one that tries to be both.
 */
export const GET = route(async () => {
  const scope = await requireScope({ departments: ["financials"] });
  return NextResponse.json(await getCashPlan(scope));
});
