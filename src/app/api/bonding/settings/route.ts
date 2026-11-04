import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, BOOKS_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import {
  deleteCreditFacility,
  setSuretyClass,
  upsertCreditFacility,
} from "@/modules/job-costing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * The two things the bonding package needs a HUMAN to supply.
 *
 * The bank line, because an unused line of credit is invisible in a ledger
 * precisely BECAUSE it is unused — and an unused line is exactly the one that
 * makes a shop bondable.
 *
 * The account classifications, because "is this asset current?" and "would a
 * surety lend against it?" are judgements a CPA makes about a specific chart.
 * Software that inferred them from account names would be guessing about the
 * number bonding capacity is sized from.
 */
const Body = z.union([
  z.object({
    action: z.literal("facility"),
    id: z.string().uuid().optional(),
    lender: z.string().trim().min(1).max(120),
    kind: z.enum(["line-of-credit", "term-loan", "equipment-loan", "other"]),
    limitCents: z.number().int().min(0),
    balanceCents: z.number().int().min(0),
    rateBps: z.number().int().min(0).max(100_000).nullable().optional(),
    maturesOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    personallyGuaranteed: z.boolean().optional(),
    notes: z.string().max(500).optional(),
  }),
  z.object({ action: z.literal("delete-facility"), id: z.string().uuid() }),
  z.object({
    action: z.literal("classify"),
    code: z.string().trim().min(1).max(20),
    suretyClass: z.enum(["intangible", "related-party", "non-current"]).nullable(),
  }),
]);

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({
    roles: [...BOOKS_ROLES],
    departments: ["financials"],
  });
  await assertCapability(scope, "bonding");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");

  if (parsed.data.action === "delete-facility") {
    await deleteCreditFacility(scope, parsed.data.id);
    return NextResponse.json({ ok: true });
  }
  if (parsed.data.action === "classify") {
    await setSuretyClass(scope, parsed.data.code, parsed.data.suretyClass);
    return NextResponse.json({ ok: true });
  }
  const { action: _action, ...facility } = parsed.data;
  await upsertCreditFacility(scope, facility);
  return NextResponse.json({ ok: true });
});
