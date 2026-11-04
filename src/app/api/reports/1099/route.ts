import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { get1099Summary } from "@/modules/purchasing-ap";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({ departments: ["financials"] });
  const year = Number(req.nextUrl.searchParams.get("year") ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return errorResponse(400, "invalid_year");
  }
  return NextResponse.json({ year, vendors: await get1099Summary(scope, year) });
});
