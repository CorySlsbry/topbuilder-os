import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import {
  COST_CODE_PRESETS,
  listCostCodes,
  seedCostCodePreset,
  upsertCostCode,
} from "@/modules/job-costing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * The shop's cost codes.
 *
 * READ IS UNWALLED, deliberately. A cost code is a label for what kind of
 * work a cost is, not a dollar figure — a tech coding a receipt in the field
 * and a dispatcher looking at a job both need the list, and neither of them
 * holds the financials wall. The AMOUNTS stay walled everywhere they always
 * were; this is the vocabulary, not the numbers.
 */
export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({});
  const includeInactive = req.nextUrl.searchParams.get("all") === "1";
  return NextResponse.json({
    costCodes: await listCostCodes(scope, { includeInactive }),
    presets: COST_CODE_PRESETS.map((p) => ({
      key: p.key,
      label: p.label,
      blurb: p.blurb,
      count: new Set(p.codes.map((c) => c.code)).size,
    })),
  });
});

const Body = z.union([
  z.object({ action: z.literal("seed"), preset: z.string().trim().min(1).max(40) }),
  z.object({
    action: z.literal("upsert"),
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["labor", "material", "sub", "equipment", "other"]),
    division: z.string().trim().max(60).optional(),
    glAccountCode: z.string().trim().max(20).optional(),
    isActive: z.boolean().optional(),
  }),
]);

/**
 * Writing the chart is an owner/admin job — it reshapes every job-cost report
 * in the business — so it takes WRITE_ROLES. Not aal2: this is setup, it
 * moves no money, and every change is visible on the screen that made it.
 */
export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");

  if (parsed.data.action === "seed") {
    return NextResponse.json(await seedCostCodePreset(scope, parsed.data.preset));
  }
  const { code, name, kind, division, glAccountCode, isActive } = parsed.data;
  await upsertCostCode(scope, { code, name, kind, division, glAccountCode, isActive });
  return NextResponse.json({ ok: true });
});
