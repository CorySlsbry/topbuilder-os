import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getPortalScopeForInvoice } from "@/modules/crm";
import { createInvoiceCheckout, stripeEnabled } from "@/modules/sales-invoicing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ invoiceId: z.string().uuid() });

// "Pay now" from the customer portal: the token must own the invoice.
export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
    if (!stripeEnabled()) return errorResponse(503, "payments_not_configured");
    const { token } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    const scope = await getPortalScopeForInvoice(token, parsed.data.invoiceId);
    // The return path must NOT carry the portal token.
    //
    // It used to be `/portal/${token}`, which Stripe stores verbatim as the
    // session's success_url and cancel_url — so the customer's standing
    // credential ended up visible in the Stripe dashboard to anyone with
    // dashboard access, on top of the access logs and browser history it
    // already sat in. That token reads their whole job and invoice history
    // and can approve an estimate, which sets a binding contract value.
    //
    // A token-free confirmation page costs the customer one tap to get back
    // to their portal (from the link they were originally sent) and costs the
    // token one more place to leak from.
    const r = await createInvoiceCheckout(scope, parsed.data.invoiceId, "/portal/paid");
    return NextResponse.json(r, { status: 201 });
  },
);
