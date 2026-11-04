import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { listBankTxns } from "@/modules/bank-rec";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({ departments: ["financials"] });
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  return NextResponse.json({ txns: await listBankTxns(scope, status) });
});
