import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, BOOKS_ROLES } from "@/modules/auth-tenancy";
import { getBookBalance, reconcile } from "@/modules/bank-rec";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Body = z.object({
  bankAccountId: z.string().uuid(),
  periodEnd: z.string().regex(DATE),
  /**
   * The ending balance printed on the statement.
   *
   * ⛔ REQUIRED. Reconciling used to mean "the review queue is empty", which
   * misses every failure that leaves nothing in the queue: a statement line
   * that never imported, a duplicate the dedupe missed, a payment somebody
   * keyed in that never happened. Comparing against the number the bank
   * printed is the only check that catches those.
   */
  statementEndingCents: z.number().int(),
  /** Required by the database when the difference is not zero. */
  differenceReason: z.string().trim().max(300).optional(),
});

/** What the books say, so the screen can show the difference BEFORE anybody
 *  commits to locking a period. */
export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({ departments: ["financials"] });
  const p = req.nextUrl.searchParams;
  const id = p.get("bankAccountId");
  const asOf = p.get("asOf") ?? new Date().toISOString().slice(0, 10);
  if (!id || !UUID.test(id) || !DATE.test(asOf)) return errorResponse(400, "invalid_query");
  return NextResponse.json(await getBookBalance(scope, id, asOf));
});

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...BOOKS_ROLES], departments: ["financials"] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const { bankAccountId, periodEnd, statementEndingCents, differenceReason } = parsed.data;
  const result = await reconcile(
    scope,
    bankAccountId,
    periodEnd,
    statementEndingCents,
    differenceReason,
  );
  return NextResponse.json(result, { status: 201 });
});
