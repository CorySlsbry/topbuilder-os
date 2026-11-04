import { NextResponse } from "next/server";
import { z } from "zod";
import { BOOKS_ROLES, requireScope } from "@/modules/auth-tenancy";
import {
  approveChangeOrder,
  declineChangeOrder,
  sendChangeOrder,
  voidChangeOrder,
} from "@/modules/estimating";
import { idempotent } from "@/lib/http/idempotency";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send") }),
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("decline"), note: z.string().trim().max(300).optional() }),
  z.object({ action: z.literal("void"), reason: z.string().trim().min(1).max(300) }),
]);

/**
 * Decide a change order.
 *
 * ── The authz, decided deliberately ──────────────────────────────────────
 * APPROVE moves a binding contract number, so it sits behind the financials
 * wall and BOOKS_ROLES — everyone but the viewer, including the bookkeeper,
 * who legitimately records "the customer said yes on the phone".
 *
 * It is NOT aal2, and that is a choice rather than an oversight: approving a
 * change order is a routine daily action, the equivalent estimate approval has
 * never required a second factor, and inventing a stricter rule in one place
 * makes the rule harder to reason about everywhere. Step-up is reserved for
 * the destructive and the irreversible.
 *
 * VOID is exactly that, so it IS aal2 — the same posture as voiding an
 * invoice. It writes a reversing movement rather than deleting anything: the
 * history of a contract is the point, and someone asking "why is this job
 * $4,200 over the estimate?" needs to see both rows.
 */
export const POST = route(
  idempotent<Ctx>(
    "changeOrders.decide",
    { scope: { roles: [...BOOKS_ROLES], departments: ["financials"] }, require: true },
    async (body, scope, ctx) => {
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");
      const { id } = await ctx.params;

      switch (parsed.data.action) {
        case "send":
          await sendChangeOrder(scope, id);
          return NextResponse.json({ ok: true });
        case "approve":
          return NextResponse.json(await approveChangeOrder(scope, id, "office"));
        case "decline":
          await declineChangeOrder(scope, id, parsed.data.note ?? "");
          return NextResponse.json({ ok: true });
        case "void": {
          // Re-resolve WITH the step-up requirement. Voiding reverses a
          // contract movement; it belongs with invoice voids and period
          // closes, not with routine approvals.
          await requireScope({
            roles: [...BOOKS_ROLES],
            departments: ["financials"],
            aal2: true,
          });
          await voidChangeOrder(scope, id, parsed.data.reason);
          return NextResponse.json({ ok: true });
        }
      }
    },
  ),
);
