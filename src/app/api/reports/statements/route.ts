import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { getArAging, getScoreboard, getStatements } from "@/modules/reporting";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({ departments: ["financials"] });
  const p = req.nextUrl.searchParams;
  const to = p.get("to") ?? new Date().toISOString().slice(0, 10);
  const from = p.get("from");
  if (!DATE.test(to) || (from !== null && !DATE.test(from))) {
    return errorResponse(400, "invalid_date");
  }
  const weekStart = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const [statements, aging, scoreboard] = await Promise.all([
    getStatements(scope, { from, to }),
    getArAging(scope, to),
    getScoreboard(scope, weekStart),
  ]);
  return NextResponse.json({ statements, aging, scoreboard });
});
