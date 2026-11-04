import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import {
  getBacklog,
  getCipSchedule,
  getCompletedContracts,
  getRatioPanel,
  listCreditFacilities,
} from "@/modules/job-costing";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The whole bonding package in one read: contracts in progress, completed
 * contracts with profit fade, backlog, the ratio panel, and the bank line.
 *
 * One request because that is how it is used — somebody opens this screen
 * with their agent on the phone, and five sequential round trips is five
 * chances to be halfway through a sentence when a number appears.
 *
 * Financials wall, obviously. This is the shop's whole balance sheet.
 */
export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({ departments: ["financials"] });
  await assertCapability(scope, "bonding");
  const p = req.nextUrl.searchParams;
  const asOf = p.get("asOf");
  const from = p.get("from");
  const to = p.get("to");

  const on = asOf && DATE.test(asOf) ? asOf : undefined;
  const today = new Date().toISOString().slice(0, 10);
  const periodTo = to && DATE.test(to) ? to : (on ?? today);
  const periodFrom =
    from && DATE.test(from)
      ? from
      : `${Number(periodTo.slice(0, 4)) - 1}${periodTo.slice(4)}`;

  const [cip, completed, backlog, ratios, facilities] = await Promise.all([
    getCipSchedule(scope, on),
    getCompletedContracts(scope, periodFrom, periodTo),
    getBacklog(scope),
    getRatioPanel(scope, on),
    listCreditFacilities(scope),
  ]);

  return NextResponse.json({ cip, completed, backlog, ratios, facilities });
});
