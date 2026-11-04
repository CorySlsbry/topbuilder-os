import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { getFormSettings, setFormSettings } from "@/modules/field-ops";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ gateCompletion: z.boolean() });

/**
 * The switch that decides whether an unfinished form can stop a job being
 * marked complete.
 *
 * Owner/admin, and deliberately NOT aal2 — different from the job-visibility
 * setting next door, and the difference is the point. That one discloses pay
 * information, so it belongs with the step-up surfaces. This one changes a
 * workflow rule, and the person most likely to need it is an owner standing
 * next to a stuck crew at 6pm. Making them find a second factor first means
 * the practical fix becomes "turn the whole feature off", which is worse for
 * the shop than the rule ever was.
 */
export const GET = route(async () => {
  const scope = await requireScope();
  return NextResponse.json(await getFormSettings(scope));
});

export const PATCH = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: ["owner", "admin"] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  return NextResponse.json(await setFormSettings(scope, parsed.data.gateCompletion));
});
