import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, BOOKS_ROLES } from "@/modules/auth-tenancy";
import { bookVisit, completeVisit, listVisits } from "@/modules/agreements";
import { route } from "@/lib/http/route";
import { idempotent } from "@/lib/http/idempotency";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.union([
  z.object({
    action: z.literal("book"),
    visitId: z.string().uuid(),
    jobId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("complete"),
    visitId: z.string().uuid(),
    completedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
]);

/** The tune-up queue: ?status=due|booked (default: all open). */
export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope();
  const status = req.nextUrl.searchParams.get("status");
  return NextResponse.json({
    visits: await listVisits(
      scope,
      status === "due" || status === "booked" ? status : undefined,
    ),
  });
});

/**
 * Completing a visit RELEASES DEFERRED REVENUE (annual plans) — money moves,
 * so the key is required and the store locks the agreement row. Booking
 * rides along keyed as well; a double-booked visit is only confusing, but a
 * double-completed one would double-earn.
 */
export const POST = route(
  idempotent(
    "agreements.visits",
    {
      // ⛔ THIS ROUTE POSTS TO THE GENERAL LEDGER and was the only one that
      // did so with a single factor — every other GL-posting route (manual
      // journal entries, credit memos, voids, the WIP adjustment, closing a
      // period) requires aal2. BOOKS_ROLES rather than WRITE_ROLES for the
      // same reason: WRITE_ROLES omits `bookkeeper`, so the CPA seat — the
      // one that would notice a revenue-recognition error — could not fix
      // one, while `staff` could create one.
      scope: {
        roles: [...BOOKS_ROLES],
        departments: ["financials"],
        aal2: true,
      },
      require: true,
    },
    async (body, scope) => {
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");
      if (parsed.data.action === "book") {
        await bookVisit(scope, parsed.data.visitId, parsed.data.jobId);
        return NextResponse.json({ ok: true });
      }
      const result = await completeVisit(
        scope,
        parsed.data.visitId,
        parsed.data.completedOn,
      );
      return NextResponse.json(result);
    },
  ),
);
