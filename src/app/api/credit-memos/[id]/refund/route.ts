import { NextResponse } from "next/server";
import { z } from "zod";
import { refundCreditMemo } from "@/modules/sales-invoicing";
import { route } from "@/lib/http/route";
import { idempotent } from "@/lib/http/idempotency";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  method: z.enum(["stripe", "check", "ach", "cash"]),
  paymentId: z.string().uuid().optional(),
  reference: z.string().max(60).optional(),
  refundedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Money OUT. 'stripe' really moves it (refunds the original charge —
 * Stripe's idempotency layer plus ours means a retry can't refund twice);
 * check/cash/ach record a refund made outside the system, same honesty rule
 * as bill payments.
 */
export const POST = route(
  idempotent<{ params: Promise<{ id: string }> }>(
    "credit-memos.refund",
    {
      scope: {
        roles: ["owner", "admin", "bookkeeper"],
        departments: ["financials"],
        aal2: true,
      },
      require: true,
    },
    async (body, scope, ctx) => {
      const { id } = await ctx.params;
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");
      const result = await refundCreditMemo(scope, {
        creditMemoId: id,
        ...parsed.data,
      });
      return NextResponse.json(result, { status: 201 });
    },
  ),
);
