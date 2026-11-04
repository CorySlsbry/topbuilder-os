import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, BOOKS_ROLES } from "@/modules/auth-tenancy";
import { createVendor, listVendors } from "@/modules/purchasing-ap";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  is1099: z.boolean().optional(),
  taxIdLast4: z.string().regex(/^\d{4}$/).optional(),
  defaultAccountCode: z.string().max(20).optional(),
});

export const GET = route(async () => {
  const scope = await requireScope({ departments: ["financials"] });
  return NextResponse.json({ vendors: await listVendors(scope) });
});

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...BOOKS_ROLES], departments: ["financials"] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const id = await createVendor(scope, parsed.data);
  return NextResponse.json({ id }, { status: 201 });
});
