import { NextResponse, type NextRequest } from "next/server";
import { handleCheckoutCompleted, verifyStripeSignature } from "@/modules/sales-invoicing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

// Stripe webhook: FAILS CLOSED without STRIPE_WEBHOOK_SECRET; signature is
// the t.v1 HMAC over the RAW body (constant-time, 5-min tolerance); the
// handler re-verifies the tenant+invoice MAC and dedupes on session id.
export const POST = route(async (req: NextRequest) => {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return errorResponse(503, "webhook_not_configured");
  }
  const raw = await req.text();
  if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"))) {
    return errorResponse(401, "bad_signature");
  }
  const result = await handleCheckoutCompleted(JSON.parse(raw));
  return NextResponse.json(result);
});
