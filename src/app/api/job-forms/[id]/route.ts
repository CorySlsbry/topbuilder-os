import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { completeForm, reopenForm } from "@/modules/field-ops";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ action: z.enum(["complete", "reopen"]) });

/**
 * Finish a form, or reopen a finished one.
 *
 * Completing REFUSES while any required item is unanswered, and the error
 * names them — the same rule the screen shows, enforced here so that it is
 * true rather than merely displayed.
 *
 * Reopening is its own action rather than an implicit side effect of editing,
 * because silently changing a signed record is the exact thing a signature
 * exists to prevent.
 */
export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...WRITE_ROLES] });
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    if (parsed.data.action === "complete") await completeForm(scope, id);
    else await reopenForm(scope, id);
    return NextResponse.json({ ok: true });
  },
);
