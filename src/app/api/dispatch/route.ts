import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { getBoard } from "@/modules/scheduling-dispatch";
import { scheduleAppointment } from "@/modules/field-ops";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  jobId: z.string().uuid(),
  startsAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  endsAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  notes: z.string().max(300).optional(),
});

export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope();
  await assertCapability(scope, "dispatch");
  const weekStart = req.nextUrl.searchParams.get("weekStart");
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return errorResponse(400, "invalid_week_start");
  }
  return NextResponse.json(await getBoard(scope, weekStart));
});

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  await assertCapability(scope, "dispatch");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const id = await scheduleAppointment(scope, parsed.data);
  return NextResponse.json({ id }, { status: 201 });
});
