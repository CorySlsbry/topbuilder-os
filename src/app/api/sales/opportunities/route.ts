import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { createOpportunity, listOpportunities } from "@/modules/prospecting";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  const customerId = req.nextUrl.searchParams.get("customerId") ?? undefined;
  if (customerId && !z.string().uuid().safeParse(customerId).success) {
    return errorResponse(422, "bad_customer_id");
  }
  return NextResponse.json({
    opportunities: await listOpportunities(scope, { customerId }),
  });
});

const Body = z.object({
  customerId: z.string().uuid(),
  title: z.string().min(1).max(160),
  valueCents: z.number().int().min(0).max(100_000_000_00).optional(),
  propertyId: z.string().uuid().optional(),
  source: z.enum(["manual", "map"]).optional(),
});

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return errorResponse(422, "bad_body");
  return NextResponse.json(await createOpportunity(scope, parsed.data), { status: 201 });
});
