import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { decide } from "@/modules/agents";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve") }),
  z.object({ type: z.literal("revise"), edit: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("reject"), reason: z.string().max(500).optional() }),
]);

export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    // requireScope() alone is only 'is a member'. The per-kind authz is
    // enforced inside the gate, which needs the assurance level too.
    const scope = await requireScope({ roles: [...WRITE_ROLES] });
    await assertCapability(scope, "agents");
    const { aal } = await requireAuth();
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    return NextResponse.json(await decide(scope, id, parsed.data, aal));
  },
);
