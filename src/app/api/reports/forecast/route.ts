import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { getCashForecast, getOwnerKpis } from "@/modules/reporting";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const scope = await requireScope({ departments: ["financials"] });
  const [forecast, kpis] = await Promise.all([getCashForecast(scope), getOwnerKpis(scope)]);
  return NextResponse.json({ forecast, kpis });
});
