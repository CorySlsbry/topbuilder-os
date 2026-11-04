import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { listPostedTxns } from "@/modules/bank-rec";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/**
 * Everything already answered, and what it was coded to — read out of the
 * ledger, not out of a cached column. This is the list somebody scans when
 * they think "I'm sure that supply-house charge went to the wrong job."
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({ departments: ["financials"] });
  const p = req.nextUrl.searchParams;
  // The query casts this to uuid. A junk value would surface as a 500 from a
  // Postgres 22P02 rather than the 400 it actually is.
  const acct = p.get("bankAccountId");
  return NextResponse.json({
    txns: await listPostedTxns(scope, {
      bankAccountId: acct && UUID.test(acct) ? acct : undefined,
      q: p.get("q") ?? undefined,
      limit: Number(p.get("limit")) || undefined,
    }),
  });
});
