import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { getWipReport, takeWipSnapshot } from "@/modules/job-costing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * Portfolio WIP — the owner's (and later the CPA's) over/under view.
 *
 * Behind the financials wall: this is every job's contract value, cost-to-date
 * and under/overbilling. The sidebar has always hidden it from someone without
 * that grant, but hiding is UX — before this the same numbers came back to a
 * bare `curl` from any viewer seat, which is exactly the seat you hand a
 * subcontractor.
 */
export const GET = route(async () => {
  const scope = await requireScope({ departments: ["financials"] });
  await assertCapability(scope, "bonding");
  return NextResponse.json(await getWipReport(scope));
});

const Body = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** Freeze today's WIP for every open job into immutable snapshots. */
export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({
    roles: [...WRITE_ROLES],
    departments: ["financials"],
  });
  await assertCapability(scope, "bonding");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const report = await getWipReport(scope);
  const ids: string[] = [];
  for (const row of report.rows) {
    ids.push(await takeWipSnapshot(scope, row.jobId, parsed.data.asOf));
  }
  return NextResponse.json({ snapshots: ids.length }, { status: 201 });
});
