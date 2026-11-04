import { NextResponse } from "next/server";
import { z } from "zod";
import { payBill } from "@/modules/purchasing-ap";
import { BOOKS_ROLES } from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";
import { idempotent } from "@/lib/http/idempotency";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountCents: z.number().int().positive(),
  method: z.enum(["check", "ach", "card", "cash"]).optional(),
  reference: z.string().max(60).optional(),
});

/**
 * Record a payment against a bill.
 *
 * Idempotency is REQUIRED here, not optional. A bill payment has no natural
 * unique key — the same vendor can legitimately be paid the same amount on the
 * same day twice — so nothing else would catch a double submit. Two POSTs mean
 * two payments and two journal entries; the books still balance, and it
 * surfaces weeks later as a bank reconciliation that will not tie.
 */
export const POST = route(
  idempotent<{ params: Promise<{ id: string }> }>(
    "bills.pay",
    { scope: { roles: [...BOOKS_ROLES], departments: ["financials"] }, require: true },
    async (body, scope, ctx) => {
      const { id } = await ctx.params;
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");
      return NextResponse.json(await payBill(scope, id, parsed.data));
    },
  ),
);
