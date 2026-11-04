import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { assignAppointment, setAppointmentStatus } from "@/modules/scheduling-dispatch";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.union([
  z.object({
    appointmentId: z.string().uuid(),
    workerId: z.string().uuid().nullable(),
  }),
  z.object({
    appointmentId: z.string().uuid(),
    status: z.enum(["done", "canceled"]),
  }),
]);

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  await assertCapability(scope, "dispatch");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  if ("status" in parsed.data) {
    await setAppointmentStatus(scope, parsed.data.appointmentId, parsed.data.status);
  } else {
    await assignAppointment(scope, parsed.data.appointmentId, parsed.data.workerId);
  }
  return NextResponse.json({ ok: true });
});
