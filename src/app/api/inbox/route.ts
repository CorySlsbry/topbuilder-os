import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { draftAvailable, listThreads, openThreadForCustomer, polishAvailable } from "@/modules/comms";
import { idempotent } from "@/lib/http/idempotency";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * The shared inbox list.
 *
 * NO department wall on purpose. The inbox is the front desk, and the front
 * desk is whoever picks up — a tech on a roof answering "running 20 minutes
 * late" is the point, not an exception. It carries customer contact details,
 * which every member can already see on /customers, and no money.
 *
 * ?status=open|closed|all  ?mine=1
 */
export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope();
  await assertCapability(scope, "comms");
  const status = req.nextUrl.searchParams.get("status");
  const threads = await listThreads(scope, {
    status: status === "closed" || status === "all" ? status : "open",
    mine: req.nextUrl.searchParams.get("mine") === "1",
  });
  return NextResponse.json({
    threads,
    me: scope.uid,
    // The screen hides the polish button rather than offering one that 503s.
    polish: polishAvailable(),
    // Same reason, same shape: no key, no button. The voicemail drafter and
    // polish happen to share a key today, and stating them separately means
    // one can be turned off without the other looking broken.
    draft: draftAvailable(),
    // And hides the whole compose box for a seat that cannot write — the
    // public demo is a `viewer`, and a marketing surface whose Send button
    // returns 403 reads as "this product is broken", not "read-only tour".
    // Courtesy only: the server is still the enforcement.
    canWrite: (WRITE_ROLES as readonly string[]).includes(scope.role),
  });
});

const Body = z.object({
  action: z.literal("open-for-customer"),
  customerId: z.string().uuid(),
});

/** "Text this customer" from anywhere else in the app. Finds or starts the
 *  one thread for that person — never a second one.
 *
 *  `route()` on the OUTSIDE: idempotent() re-throws domain errors, and without
 *  the envelope wrapper a clean 422 ("this customer has no phone or email")
 *  reaches the client as a generic 500. */
export const POST = route(
  idempotent("inbox.open", { scope: { roles: WRITE_ROLES } }, async (body, scope) => {
    const parsed = Body.safeParse(body);
    if (!parsed.success) return errorResponse(400, "invalid_body");
    return NextResponse.json(await openThreadForCustomer(scope, parsed.data.customerId));
  }),
);
