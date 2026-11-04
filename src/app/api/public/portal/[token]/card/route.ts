import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getPortalCustomerScope } from "@/modules/crm";
import { confirmCardSetup, createCardSetup } from "@/modules/agreements";
import { publishableKey } from "@/modules/billing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.union([
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("confirm"), setupIntentId: z.string().min(8).max(200) }),
]);

/**
 * Save-a-card, from the CUSTOMER's portal.
 *
 * The card number goes customer → Stripe element → Stripe. It never touches
 * this server and is never typed by the office — that is what keeps the
 * platform out of PCI scope and honors the no-raw-credentials rule. `start`
 * mints the SetupIntent the element needs; `confirm` verifies with STRIPE
 * what was saved (the client's claim is never trusted) and stores the
 * reference. The token pins everything to its own customer.
 */
export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
    const { token } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    const { scope, customerId } = await getPortalCustomerScope(token);

    if (parsed.data.action === "start") {
      const r = await createCardSetup(scope, customerId);
      // The portal has no session, so /api/billing/config (requireScope) is
      // out of reach — the publishable key rides along here instead. It is
      // publishable by design; serving it at runtime just keeps rotation a
      // config change, same rule as the billing page.
      return NextResponse.json(
        { ...r, publishableKey: publishableKey() },
        { status: 201 },
      );
    }
    const saved = await confirmCardSetup(scope, customerId, parsed.data.setupIntentId);
    return NextResponse.json(saved, { status: 201 });
  },
);
