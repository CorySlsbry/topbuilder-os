import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { adjustCount, issueToJob, receiveStock } from "@/modules/inventory";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const Body = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("receive"),
    itemId: z.string().uuid(),
    qtyX100: z.number().int().positive(),
    unitCostCents: z.number().int().positive(),
    vendorName: z.string().trim().min(1).max(160),
    occurredOn: z.string().regex(DATE),
    poId: z.string().uuid().optional(),
    memo: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal("issue"),
    itemId: z.string().uuid(),
    qtyX100: z.number().int().positive(),
    jobId: z.string().uuid(),
    costCode: z.string().max(20).optional(),
    occurredOn: z.string().regex(DATE),
    memo: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal("adjust"),
    itemId: z.string().uuid(),
    countedQtyX100: z.number().int().min(0),
    occurredOn: z.string().regex(DATE),
    memo: z.string().max(300).optional(),
  }),
]);

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  await assertCapability(scope, "inventory");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const d = parsed.data;
  if (d.type === "receive") return NextResponse.json(await receiveStock(scope, d), { status: 201 });
  if (d.type === "issue") return NextResponse.json(await issueToJob(scope, d), { status: 201 });
  return NextResponse.json(await adjustCount(scope, d), { status: 201 });
});
