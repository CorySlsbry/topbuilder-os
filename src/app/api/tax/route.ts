import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { getSalesTaxSummary, remitTax } from "@/modules/sales-invoicing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";
const Body = z.object({
  periodLabel: z.string().regex(/^\d{4}-\d{2}$/),
  amountCents: z.number().int().positive(),
  remittedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const GET = route(async () => {
  const scope = await requireScope({ departments: ["financials"] });
  return NextResponse.json(await getSalesTaxSummary(scope));
});

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: ["owner", "admin"], departments: ["financials"] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const d = parsed.data;
  return NextResponse.json(await remitTax(scope, d.periodLabel, d.amountCents, d.remittedOn), { status: 201 });
});
