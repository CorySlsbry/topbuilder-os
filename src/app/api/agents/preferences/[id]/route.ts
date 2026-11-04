import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { approvePreference, demotePreference } from "@/modules/agents";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ action: z.enum(["approve", "demote"]) });

export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: ["owner", "admin"] });
    await assertCapability(scope, "agents");
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    if (parsed.data.action === "demote") {
      await demotePreference(scope, id);
      return NextResponse.json({ status: "demoted" });
    }
    return NextResponse.json(await approvePreference(scope, id));
  },
);
