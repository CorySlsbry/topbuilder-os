import { NextResponse, type NextRequest } from "next/server";
import { requireAuth, requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { undoAction } from "@/modules/agents";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

export const POST = route(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    // requireScope() alone is only 'is a member'. The per-kind authz is
    // enforced inside the gate, which needs the assurance level too.
    const scope = await requireScope({ roles: [...WRITE_ROLES] });
    await assertCapability(scope, "agents");
    const { aal } = await requireAuth();
    const { id } = await ctx.params;
    return NextResponse.json(await undoAction(scope, id, aal));
  },
);
