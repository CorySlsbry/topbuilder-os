import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { closePeriod, listPeriods } from "@/modules/ledger";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";
const Body = z.object({ periodStart: z.string().regex(/^\d{4}-\d{2}-01$/) });

export const GET = route(async () => {
  const scope = await requireScope({ departments: ["financials"] });
  return NextResponse.json({ periods: await listPeriods(scope) });
});

// Closing a month locks its postings forever — owner/admin/bookkeeper.
export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({
    roles: ["owner", "admin", "bookkeeper"],
    departments: ["financials"],
    aal2: true,
  });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  await closePeriod(scope, parsed.data.periodStart);
  return NextResponse.json({ ok: true }, { status: 201 });
});
