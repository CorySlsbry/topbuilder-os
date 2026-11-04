import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { addPricebookItem, listPricebook } from "@/modules/estimating";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(500).optional(),
  unit: z.string().max(30).optional(),
  unitPriceCents: z.number().int().positive(),
  unitCostCents: z.number().int().nonnegative().optional(),
  trade: z.string().max(60).optional(),
  category: z.string().max(60).optional(),
});

export const GET = route(async () => {
  const scope = await requireScope();
  // Financing display terms (partner keys later swap the apply link in).
  const financing = {
    aprBps: Number(process.env.FINANCING_APR_BPS ?? 999),
    termMonths: Number(process.env.FINANCING_TERM_MONTHS ?? 60),
    applyUrl: process.env.FINANCING_APPLY_URL ?? "",
  };
  return NextResponse.json({ items: await listPricebook(scope), financing });
});

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES], departments: ["field"] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const id = await addPricebookItem(scope, parsed.data);
  return NextResponse.json({ id }, { status: 201 });
});
