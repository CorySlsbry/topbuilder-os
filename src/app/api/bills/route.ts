import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, BOOKS_ROLES } from "@/modules/auth-tenancy";
import { createBill, listBills } from "@/modules/purchasing-ap";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Line = z.union([
  z.object({
    amountCents: z.number().int().positive(),
    description: z.string().max(300).optional(),
    jobId: z.string().uuid(),
    costCode: z.string().max(20).optional(),
    costKind: z.enum(["labor", "material", "sub", "equipment", "other"]).optional(),
  }),
  z.object({
    amountCents: z.number().int().positive(),
    description: z.string().max(300).optional(),
    accountCode: z.string().trim().min(1).max(20),
  }),
]);

const Body = z.object({
  vendorId: z.string().uuid(),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  billRef: z.string().max(60).optional(),
  memo: z.string().max(300).optional(),
  poId: z.string().uuid().optional(),
  lines: z.array(Line).min(1).max(50),
});

export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({ departments: ["financials"] });
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  return NextResponse.json({ bills: await listBills(scope, status) });
});

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...BOOKS_ROLES], departments: ["financials"] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const id = await createBill(scope, parsed.data);
  return NextResponse.json({ id }, { status: 201 });
});
