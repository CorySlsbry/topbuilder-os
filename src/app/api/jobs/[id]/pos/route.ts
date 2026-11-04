import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { addPurchaseOrder } from "@/modules/job-costing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  kind: z.enum(["po", "sub"]).default("po"),
  vendorName: z.string().trim().min(1).max(160),
  description: z.string().trim().max(300).optional(),
  amountCents: z.number().int().positive(),
});

export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...WRITE_ROLES] });
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    const poId = await addPurchaseOrder(scope, { jobId: id, ...parsed.data });
    return NextResponse.json({ id: poId }, { status: 201 });
  },
);
