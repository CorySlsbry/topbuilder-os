import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { listPendingWeeks, logTime } from "@/modules/workforce";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  workerId: z.string().uuid(),
  jobId: z.string().uuid(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hoursX100: z.number().int().positive().max(24_00),
  costCode: z.string().max(20).optional(),
  notes: z.string().max(300).optional(),
});

export const GET = route(async () => {
  const scope = await requireScope({ departments: ["hr"] });
  await assertCapability(scope, "workforce");
  return NextResponse.json({ weeks: await listPendingWeeks(scope) });
});

export const POST = route(async (req: NextRequest) => {
  // Logging hours is for everyone on the crew; only VIEWING the burdened
  // money (GET) sits behind the People & pay wall.
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  await assertCapability(scope, "workforce");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const id = await logTime(scope, parsed.data);
  return NextResponse.json({ id }, { status: 201 });
});
