import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { advanceStage, STAGES } from "@/modules/prospecting";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  stage: z.enum(STAGES),
  lostReason: z.string().max(300).optional(),
});

export const POST = route(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...WRITE_ROLES] });
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) return errorResponse(422, "bad_id");
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return errorResponse(422, "bad_body");
    await advanceStage(scope, id, parsed.data.stage, parsed.data.lostReason);
    return NextResponse.json({ ok: true });
  },
);
