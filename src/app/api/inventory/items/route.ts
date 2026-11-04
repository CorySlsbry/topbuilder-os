import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { createItem, listItems } from "@/modules/inventory";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().trim().min(1).max(160),
  unit: z.string().max(20).optional(),
  reorderPointX100: z.number().int().min(0).optional(),
  reorderQtyX100: z.number().int().min(0).optional(),
  preferredVendor: z.string().max(160).optional(),
});

export const GET = route(async () => {
  const scope = await requireScope();
  await assertCapability(scope, "inventory");
  return NextResponse.json({ items: await listItems(scope) });
});

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  await assertCapability(scope, "inventory");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const id = await createItem(scope, parsed.data);
  return NextResponse.json({ id }, { status: 201 });
});
