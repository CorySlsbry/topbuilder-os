import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { listAllInvoices } from "@/modules/sales-invoicing";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/** Every invoice, job-billed or membership-billed. Financials wall — this is
 *  the whole AR picture in one list. ?status=issued|partial|paid|void */
export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({ departments: ["financials"] });
  const status = req.nextUrl.searchParams.get("status");
  return NextResponse.json({
    invoices: await listAllInvoices(scope, status ?? undefined),
  });
});
