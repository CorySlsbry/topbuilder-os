import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { getJobVisibility, setJobVisibility } from "@/modules/job-costing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * The switch that decides whether the crew sees what a job made.
 *
 * Owner/admin AND a second factor. The aal2 requirement is deliberate and it
 * is NOT the house default — change orders, for instance, are approved at
 * aal1, because approving one is a routine daily action.
 *
 * This is different in kind: on a two- or three-person job, burdened labor
 * cost divided by the hours on the same screen IS a person's pay rate. Turning
 * this on is a compensation disclosure decision made once for the whole shop,
 * and it is exactly the kind of setting that should not be flippable by
 * whoever happens to be sitting at an unlocked laptop. It sits with the other
 * step-up surfaces (voids, HR), not with the daily ones.
 *
 * Lives under /api/settings rather than /api/jobs/visibility so it can never
 * shadow, or be shadowed by, the /api/jobs/[id] dynamic segment.
 *
 * The GET is not walled the same way: anyone may ask whether the setting is on
 * for their own tenant, because the profit route's answer already tells them.
 */
const Body = z.object({ crewSeesProfit: z.boolean() });

export const GET = route(async () => {
  const scope = await requireScope();
  return NextResponse.json(await getJobVisibility(scope));
});

export const PATCH = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: ["owner", "admin"], aal2: true });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  return NextResponse.json(await setJobVisibility(scope, parsed.data.crewSeesProfit));
});
