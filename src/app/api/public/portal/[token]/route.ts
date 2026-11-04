import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getPortalData,
  portalApproveChangeOrder,
  portalApproveEstimate,
} from "@/modules/crm";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

// PUBLIC: the customer's portal. The token IS the auth — revocable,
// unguessable (uuid), resolving only to that one customer's data.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Two things a customer can say yes to, so the body is a discriminated union
 * rather than two routes. The bare `{estimateId, optionId}` shape is kept as a
 * default arm because it is what the existing portal page already posts —
 * changing the wire format and the page in one commit is how a deployed client
 * ends up talking to a server that no longer understands it.
 */
const Body = z.union([
  z.object({
    action: z.literal("approve-change-order"),
    changeOrderId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("approve-estimate").optional(),
    estimateId: z.string().uuid(),
    optionId: z.string().uuid(),
  }),
]);

export const GET = route(
  async (_req: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
    const { token } = await ctx.params;
    if (!UUID.test(token)) return errorResponse(404, "portal_not_found");
    return NextResponse.json(await getPortalData(token));
  },
);

export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
    const { token } = await ctx.params;
    if (!UUID.test(token)) return errorResponse(404, "portal_not_found");
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    if (parsed.data.action === "approve-change-order") {
      return NextResponse.json(
        await portalApproveChangeOrder(token, parsed.data.changeOrderId),
      );
    }
    const r = await portalApproveEstimate(token, parsed.data.estimateId, parsed.data.optionId);
    return NextResponse.json(r);
  },
);
