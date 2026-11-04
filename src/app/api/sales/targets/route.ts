import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { listTargets, setTargetDisposition } from "@/modules/prospecting";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  return NextResponse.json({ targets: await listTargets(scope) });
});

const Body = z.object({
  customerId: z.string().uuid(),
  signalKey: z.string().min(1).max(120),
  disposition: z.enum(["dismissed", "snoozed"]),
  days: z.number().int().min(1).max(365).optional(),
});

/** Dismiss or snooze one signal on one customer. */
export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return errorResponse(422, "bad_body");
  await setTargetDisposition(scope, parsed.data);
  return NextResponse.json({ ok: true });
});
