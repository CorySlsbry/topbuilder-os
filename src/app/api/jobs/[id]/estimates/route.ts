import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { createEstimate } from "@/modules/estimating";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Line = z.object({
  description: z.string().trim().min(1).max(300),
  qtyX100: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
  pricebookItemId: z.string().uuid().optional(),
});
const Body = z.object({
  options: z
    .array(
      z.object({
        tier: z.enum(["good", "better", "best"]),
        title: z.string().trim().min(1).max(160),
        summary: z.string().trim().max(500).optional(),
        lines: z.array(Line).min(1).max(50),
      }),
    )
    .min(1)
    .max(3),
});

export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...WRITE_ROLES] });
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    const estimate = await createEstimate(scope, id, parsed.data.options);
    return NextResponse.json(estimate, { status: 201 });
  },
);
