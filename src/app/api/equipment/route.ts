import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import {
  createEquipment,
  EQUIPMENT_KINDS,
  listEquipment,
  updateEquipment,
} from "@/modules/field-ops";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const Body = z.union([
  z.object({
    action: z.literal("create"),
    customerId: z.string().uuid(),
    label: z.string().trim().min(1).max(120),
    kind: z.enum(EQUIPMENT_KINDS),
    make: z.string().max(80).optional(),
    model: z.string().max(120).optional(),
    serial: z.string().max(120).optional(),
    installedOn: z.string().regex(DATE).optional(),
    warrantyUntil: z.string().regex(DATE).optional(),
    notes: z.string().max(1000).optional(),
  }),
  z.object({
    action: z.literal("update"),
    id: z.string().uuid(),
    label: z.string().trim().min(1).max(120).optional(),
    kind: z.enum(EQUIPMENT_KINDS).optional(),
    make: z.string().max(80).optional(),
    model: z.string().max(120).optional(),
    serial: z.string().max(120).optional(),
    installedOn: z.string().regex(DATE).nullable().optional(),
    warrantyUntil: z.string().regex(DATE).nullable().optional(),
    notes: z.string().max(1000).optional(),
    retired: z.boolean().optional(),
  }),
]);

/** ?customerId=… — the units at one customer, with per-unit job history. */
export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope();
  const customerId = req.nextUrl.searchParams.get("customerId");
  if (!customerId) return errorResponse(400, "customer_id_required");
  const includeRetired = req.nextUrl.searchParams.get("retired") === "1";
  return NextResponse.json({
    equipment: await listEquipment(scope, customerId, includeRetired),
  });
});

/** Techs add units from the field — WRITE_ROLES, not a wall: the person
 *  standing at the condenser is exactly who should record its serial. */
export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  if (parsed.data.action === "create") {
    const { action: _a, ...input } = parsed.data;
    const id = await createEquipment(scope, input);
    return NextResponse.json({ id }, { status: 201 });
  }
  const { action: _b, id, ...patch } = parsed.data;
  await updateEquipment(scope, id, patch);
  return NextResponse.json({ ok: true });
});
