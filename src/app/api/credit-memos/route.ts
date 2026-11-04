import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { createCreditMemo, listCreditMemos } from "@/modules/sales-invoicing";
import { route } from "@/lib/http/route";
import { idempotent } from "@/lib/http/idempotency";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  customerId: z.string().uuid(),
  invoiceId: z.string().uuid().optional(),
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(1).max(300),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const GET = route(async () => {
  const scope = await requireScope({ departments: ["financials"] });
  return NextResponse.json({ creditMemos: await listCreditMemos(scope) });
});

/**
 * Giving money back is a financials power with a second factor — the same
 * bar as closing a period. A reason is REQUIRED: "why did we credit this
 * customer $150" is the first question the CPA (or a dispute) asks.
 */
export const POST = route(
  idempotent(
    "credit-memos",
    {
      scope: {
        roles: ["owner", "admin", "bookkeeper"],
        departments: ["financials"],
        aal2: true,
      },
      require: true,
    },
    async (body, scope) => {
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");
      const result = await createCreditMemo(scope, parsed.data);
      return NextResponse.json(result, { status: 201 });
    },
  ),
);
