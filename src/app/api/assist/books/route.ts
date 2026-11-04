import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { askBooks } from "@/modules/books-qa";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ question: z.string().trim().min(1).max(500) });

/**
 * "Ask your books" — a question about the shop's own records.
 *
 * ⛔ requireScope() with NO department wall, on purpose. The wall is applied
 * PER TOOL inside, because the honest answer for a member without the
 * financials grant is not 403 — it is a real answer drawn from the tools they
 * do hold. Putting the wall here would make the feature invisible to half a
 * shop rather than appropriately narrow.
 *
 * WRITE_ROLES because this is metered: a read-only seat, the public demo
 * included, has no business spending a shop's model budget.
 *
 * It changes nothing. Every tool is a read, there is no SQL tool, and the
 * answer is gated by the figure firewall before it is returned.
 */
export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: WRITE_ROLES });
  await assertCapability(scope, "booksQa");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  return NextResponse.json(await askBooks(scope, parsed.data.question));
});
