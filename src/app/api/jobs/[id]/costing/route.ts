import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { getJobCosting, listPurchaseOrders, setEtc } from "@/modules/job-costing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * The job-money view: WIP, committed, costs-by-code, plain-language explainers.
 * Financials wall — cost and margin per job is not field-crew information.
 */
export const GET = route(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ departments: ["financials"] });
    const { id } = await ctx.params;
    const costing = await getJobCosting(scope, id);
    const purchaseOrders = await listPurchaseOrders(scope, id);
    return NextResponse.json({ ...costing, purchaseOrders });
  },
);

const Body = z.object({ etcCents: z.number().int().nonnegative() });

/** Set the owner's estimate-to-complete (the WIP input only they can supply). */
export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    // ETC is a WIP input: it moves earned revenue and the over/under split.
    const scope = await requireScope({
      roles: [...WRITE_ROLES],
      departments: ["financials"],
    });
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    await setEtc(scope, id, parsed.data.etcCents);
    return NextResponse.json({ ok: true });
  },
);
