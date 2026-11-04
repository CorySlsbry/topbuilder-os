import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { createIntake, listIntake, openSlots, setIntakeStatus } from "@/modules/intake";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.union([
  z.object({
    type: z.literal("manual"),
    externalId: z.string().min(1).max(120),
    name: z.string().trim().min(1).max(160),
    phone: z.string().max(40).optional(),
    email: z.string().max(160).optional(),
    address: z.string().max(240).optional(),
    description: z.string().max(1000).optional(),
    preferredWindow: z.enum(["any", "morning", "afternoon"]).optional(),
  }),
  z.object({
    type: z.literal("status"),
    intakeId: z.string().uuid(),
    status: z.enum(["declined", "spam"]),
  }),
]);

export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope();
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const [requests, slots] = await Promise.all([
    listIntake(scope, status),
    openSlots(scope, 10),
  ]);
  return NextResponse.json({ requests, slots });
});

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  if (parsed.data.type === "status") {
    await setIntakeStatus(scope, parsed.data.intakeId, parsed.data.status);
    return NextResponse.json({ ok: true });
  }
  const { type: _type, ...rest } = parsed.data;
  const r = await createIntake(scope, { source: "manual", ...rest });
  return NextResponse.json(r, { status: 201 });
});
