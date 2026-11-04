import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { getBill } from "@/modules/purchasing-ap";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * One bill in full: what it was for, and everything paid against it.
 *
 * Financials wall — a bill shows vendor pricing and which job it was costed
 * to, which is the shop's margin working backwards.
 */
export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const scope = await requireScope({ departments: ["financials"] });
  const { id } = await ctx.params;
  const bill = await getBill(scope, id);
  if (!bill) return errorResponse(404, "bill_not_found");
  return NextResponse.json(bill);
});
