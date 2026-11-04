import { NextResponse } from "next/server";
import { z } from "zod";
import { voidInvoice } from "@/modules/sales-invoicing";
import { route } from "@/lib/http/route";
import { idempotent } from "@/lib/http/idempotency";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  voidedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Void an UNPAID invoice: exact reversal of its posting, dated the void day
 * (a closed January stays closed — the reversal is a today-fact). Anything
 * with money against it refuses and points at credit memos instead.
 */
export const POST = route(
  idempotent<{ params: Promise<{ id: string }> }>(
    "invoices.void",
    {
      scope: {
        roles: ["owner", "admin", "bookkeeper"],
        departments: ["financials"],
        aal2: true,
      },
      require: true,
    },
    async (body, scope, ctx) => {
      const { id } = await ctx.params;
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");
      await voidInvoice(scope, id, parsed.data.voidedOn);
      return NextResponse.json({ ok: true });
    },
  ),
);
