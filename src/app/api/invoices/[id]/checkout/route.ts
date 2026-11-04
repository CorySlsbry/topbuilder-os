import { NextResponse, type NextRequest } from "next/server";
import { requireScope, BOOKS_ROLES } from "@/modules/auth-tenancy";
import { createInvoiceCheckout, stripeEnabled } from "@/modules/sales-invoicing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

// Card/ACH checkout for an invoice's open balance. Fails closed with a
// plain 503 until Stripe keys land — recording checks manually still works.
export const POST = route(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...BOOKS_ROLES], departments: ["field"] });
    if (!stripeEnabled()) return errorResponse(503, "payments_not_configured");
    const { id } = await ctx.params;
    const r = await createInvoiceCheckout(scope, id, "/jobs");
    return NextResponse.json(r, { status: 201 });
  },
);
