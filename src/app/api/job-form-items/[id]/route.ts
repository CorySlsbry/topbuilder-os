import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { answerItem } from "@/modules/field-ops";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  checked: z.boolean().nullable().optional(),
  valueText: z.string().max(2000).optional(),
  /**
   * Nullable, and NOT `.positive()`. Zero is a real answer — "0 leaks found"
   * is exactly what a safety checklist is asking for, and a schema that
   * rejected it would make the item impossible to complete honestly.
   */
  valueNumber: z.number().finite().nullable().optional(),
  attachmentId: z.string().uuid().nullable().optional(),
  signedName: z.string().trim().max(120).optional(),
});

/**
 * Answer ONE item.
 *
 * Per-item on purpose, and the exact opposite of how a TEMPLATE is saved: a
 * tech on a roof with two bars must not lose a whole form because one save
 * failed. The client queues these through the existing outbox, so a dropped
 * request costs one answer and retries itself.
 */
export const PATCH = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...WRITE_ROLES] });
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    await answerItem(scope, id, parsed.data);
    return NextResponse.json({ ok: true });
  },
);
