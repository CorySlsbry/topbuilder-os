import { NextResponse } from "next/server";
import { z } from "zod";
import { postWipAdjustment } from "@/modules/job-costing";
import { assertCapability } from "@/modules/billing";
import { route } from "@/lib/http/route";
import { idempotent } from "@/lib/http/idempotency";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const Body = z.object({
  asOf: z.string().regex(DATE),
  /** The revenue account the adjustment recognises against. Owner/CPA's
   *  call — a shop with divisional revenue accounts will not want 3100. */
  revenueAccountCode: z.string().trim().min(1).max(20).optional(),
});

/**
 * Post the percentage-of-completion adjusting entry.
 *
 * This is the bookkeeper's pen pointed at the balance sheet: it moves real
 * money between an asset, a liability and revenue. Same guard as a manual
 * journal entry — owner/admin/bookkeeper, financials wall, SECOND FACTOR,
 * and idempotency-keyed, because it IS a posting.
 *
 * The entry itself is idempotent by construction (it posts the DELTA to the
 * schedule's totals, and a second run has nothing left to move), and the
 * table's UNIQUE(tenant, as_of) refuses a second one for the same date
 * outright. The idempotency key is the third layer, for a retried request.
 */
export const POST = route(
  idempotent(
    "bonding.wip-adjustment",
    {
      scope: {
        roles: ["owner", "admin", "bookkeeper"],
        departments: ["financials"],
        aal2: true,
      },
      require: true,
    },
    async (body, scope) => {
      await assertCapability(scope, "bonding");
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");
      const result = await postWipAdjustment(
        scope,
        parsed.data.asOf,
        parsed.data.revenueAccountCode,
      );
      return NextResponse.json(result);
    },
  ),
);
