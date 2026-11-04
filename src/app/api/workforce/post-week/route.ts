import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { postWorkerWeek } from "@/modules/workforce";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  workerId: z.string().uuid(),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// Manual posting path (the agent proposes the same thing as a card).
// Posts money -> owner/admin.
export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({
    roles: ["owner", "admin"],
    departments: ["hr"],
    aal2: true,
  });
  await assertCapability(scope, "workforce");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  return NextResponse.json(
    await postWorkerWeek(scope, parsed.data.workerId, parsed.data.weekStart),
  );
});
