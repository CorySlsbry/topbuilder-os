import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { createChangeOrder, getJobContract } from "@/modules/estimating";
import { idempotent } from "@/lib/http/idempotency";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A job's contract story: where it started, everything that moved it, where it
 * is now — plus every change order whatever its state.
 *
 * NOT financials-walled. The contract amount is already on the job screen for
 * every member (`GET /api/jobs/[id]` returns the whole row), and a change
 * order is a scope document the field crew has to be able to read — they are
 * the ones who did the extra work.
 */
export const GET = route(async (_req: NextRequest, ctx: Ctx) => {
  const scope = await requireScope();
  const { id } = await ctx.params;
  return NextResponse.json(await getJobContract(scope, id));
});

const Body = z.object({
  title: z.string().trim().min(1).max(200),
  reason: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(300),
        qtyX100: z.number().int().positive(),
        // SIGNED — a deduct is a negative unit price, not a separate concept.
        unitPriceCents: z.number().int(),
      }),
    )
    .min(1)
    .max(50),
});

/**
 * Draft a change order. WRITE_ROLES, no financials wall: the person who
 * discovers that the job grew is usually the one holding the wrench, and a
 * change order nobody can raise until the bookkeeper is free is a change order
 * that never gets written down. Drafting moves no money; APPROVING does, and
 * that is where the wall is.
 */
export const POST = route(
  idempotent<Ctx>(
    "changeOrders.create",
    { scope: { roles: WRITE_ROLES }, require: true },
    async (body, scope, ctx) => {
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");
      const { id } = await ctx.params;
      return NextResponse.json(
        await createChangeOrder(scope, { jobId: id, ...parsed.data }),
        { status: 201 },
      );
    },
  ),
);
