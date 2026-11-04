import { type NextRequest, NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { buildIifJournal, buildQboJournalCsv, getExportRows } from "@/modules/qbo-bridge";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Export forever: the whole journal in IIF or QBO-import CSV. One click,
// no gatekeeping — reversibility is a product promise, not a favor.
export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({ departments: ["financials"] });
  const p = req.nextUrl.searchParams;
  const format = p.get("format") === "iif" ? "iif" : "csv";
  const to = p.get("to") ?? new Date().toISOString().slice(0, 10);
  const from = p.get("from");
  if (!DATE.test(to) || (from !== null && !DATE.test(from))) {
    return errorResponse(400, "invalid_date");
  }
  const rows = await getExportRows(scope, from, to);
  const body = format === "iif" ? buildIifJournal(rows) : buildQboJournalCsv(rows);
  return new NextResponse(body, {
    headers: {
      "content-type": format === "iif" ? "application/octet-stream" : "text/csv",
      "content-disposition": `attachment; filename="topbuilder-journal-${to}.${format}"`,
    },
  });
});
