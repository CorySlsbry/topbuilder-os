import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { listCategories, listCostCodes } from "@/modules/bank-rec";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/**
 * The picker's options: every category a bank line can be coded to, plus the
 * cost codes for the job-cost path. One request, because the screen needs
 * both the moment a row opens and two round trips would show an empty
 * dropdown for the length of the second one.
 *
 * Same financials wall as the rest of the bank plane — the chart of accounts
 * tells you what a business spends money on, which is not dispatch's business.
 */
export const GET = route(async () => {
  const scope = await requireScope({ departments: ["financials"] });
  const [categories, costCodes] = await Promise.all([
    listCategories(scope),
    listCostCodes(scope),
  ]);
  return NextResponse.json({ categories, costCodes });
});
