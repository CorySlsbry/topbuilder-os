import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_POSTING_ACCOUNTS } from "@/modules/field-ops";
import { recordPayment } from "@/modules/sales-invoicing";
import { BOOKS_ROLES } from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";
import { idempotent } from "@/lib/http/idempotency";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  amountCents: z.number().int().positive(),
  method: z
    .enum(["manual", "check", "ach", "card", "stripe"])
    .default("manual"),
  reference: z.string().trim().max(120).optional(),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const POST = route(
  idempotent<{ params: Promise<{ id: string }> }>(
    "invoices.payments",
    { scope: { roles: [...BOOKS_ROLES], departments: ["field"] }, require: true },
    async (body, scope, ctx) => {
      const { id } = await ctx.params;
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");
      const result = await recordPayment(scope, {
        invoiceId: id,
        accounts: DEFAULT_POSTING_ACCOUNTS,
        ...parsed.data,
      });
      return NextResponse.json(result, { status: 201 });
    },
  ),
);
