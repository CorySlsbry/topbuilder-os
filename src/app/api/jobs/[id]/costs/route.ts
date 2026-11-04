import { NextResponse } from "next/server";
import { z } from "zod";
import { WRITE_ROLES } from "@/modules/auth-tenancy";
import { captureCost, DEFAULT_POSTING_ACCOUNTS } from "@/modules/field-ops";
import { route } from "@/lib/http/route";
import { idempotent } from "@/lib/http/idempotency";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  costCode: z.string().trim().min(1).max(20),
  kind: z.enum(["labor", "material", "sub", "equipment", "other"]),
  amountCents: z.number().int().positive(),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().trim().max(500).optional(),
  paidFrom: z.enum(["cash", "ap"]).default("cash"),
});

export const POST = route(
  idempotent<{ params: Promise<{ id: string }> }>(
    "jobs.costs",
    { scope: { roles: [...WRITE_ROLES] }, require: true },
    async (body, scope, ctx) => {
      const { id } = await ctx.params;
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");
      const result = await captureCost(scope, {
        jobId: id,
        accounts: DEFAULT_POSTING_ACCOUNTS,
        ...parsed.data,
      });
      return NextResponse.json(result, { status: 201 });
    },
  ),
);
