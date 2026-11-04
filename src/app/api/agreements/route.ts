import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import {
  cancelAgreement,
  createPlan,
  enroll,
  listAgreements,
  listPlans,
  setPlanActive,
} from "@/modules/agreements";
import { route } from "@/lib/http/route";
import { idempotent } from "@/lib/http/idempotency";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const Body = z.union([
  z.object({
    action: z.literal("create-plan"),
    name: z.string().trim().min(1).max(120),
    billing: z.enum(["monthly", "annual"]),
    priceCents: z.number().int().positive().max(100_000_00),
    visitsPerYear: z.number().int().min(0).max(12),
    discountBps: z.number().int().min(0).max(5000),
    targetMonths: z.array(z.number().int().min(1).max(12)).max(12).default([]),
  }),
  z.object({
    action: z.literal("set-plan-active"),
    planId: z.string().uuid(),
    active: z.boolean(),
  }),
  z.object({
    action: z.literal("enroll"),
    planId: z.string().uuid(),
    customerId: z.string().uuid(),
    startOn: z.string().regex(DATE),
    paymentMethodId: z.string().uuid().optional(),
    equipmentIds: z.array(z.string().uuid()).max(20).optional(),
  }),
  z.object({
    action: z.literal("cancel"),
    agreementId: z.string().uuid(),
  }),
]);

/** Plans + memberships. ?customerId=… narrows to one customer. */
export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope();
  const customerId = req.nextUrl.searchParams.get("customerId") ?? undefined;
  const [plans, agreements] = await Promise.all([
    listPlans(scope),
    listAgreements(scope, customerId),
  ]);
  return NextResponse.json({ plans, agreements });
});

/**
 * Enrollment posts money (the year's or month's invoice), so the whole route
 * is idempotency-required: a double-tap on "Enroll" must not bill a customer
 * twice. Plan management rides the same wrapper — harmless for it, one less
 * split code path.
 */
export const POST = route(
  idempotent(
    "agreements",
    { scope: { roles: [...WRITE_ROLES] }, require: true },
    async (body, scope) => {
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");
      const d = parsed.data;

      if (d.action === "create-plan") {
        // Shaping the offer is owner/admin work.
        if (scope.role !== "owner" && scope.role !== "admin") {
          return errorResponse(403, "role_forbidden");
        }
        const { action: _a, ...input } = d;
        const id = await createPlan(scope, input);
        return NextResponse.json({ id }, { status: 201 });
      }
      if (d.action === "set-plan-active") {
        if (scope.role !== "owner" && scope.role !== "admin") {
          return errorResponse(403, "role_forbidden");
        }
        await setPlanActive(scope, d.planId, d.active);
        return NextResponse.json({ ok: true });
      }
      if (d.action === "enroll") {
        const { action: _b, ...input } = d;
        const result = await enroll(scope, input);
        return NextResponse.json(result, { status: 201 });
      }
      // cancel — stopping a member's billing is owner/admin work too.
      if (scope.role !== "owner" && scope.role !== "admin") {
        return errorResponse(403, "role_forbidden");
      }
      const result = await cancelAgreement(scope, d.agreementId);
      return NextResponse.json(result);
    },
  ),
);
