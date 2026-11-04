import { type NextRequest, NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import {
  buildZip,
  csvDollars,
  getArAging,
  getGlDetail,
  getStatements,
  toCsv,
  type ZipEntry,
} from "@/modules/reporting";
import { getWipReport } from "@/modules/job-costing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The CPA Hand-Over Pack: everything an outside accountant needs to pick up
// the books in ten minutes, as plain CSVs any tool (Excel, QBO) can open.
export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({ departments: ["financials"] });
  const p = req.nextUrl.searchParams;
  const to = p.get("to") ?? new Date().toISOString().slice(0, 10);
  const from = p.get("from");
  if (!DATE.test(to) || (from !== null && !DATE.test(from))) {
    return errorResponse(400, "invalid_date");
  }

  const [stmts, gl, aging, wip] = await Promise.all([
    getStatements(scope, { from, to }),
    getGlDetail(scope, { from, to }),
    getArAging(scope, to),
    getWipReport(scope),
  ]);

  const entries: ZipEntry[] = [
    {
      name: `trial-balance-${to}.csv`,
      content: toCsv(
        ["Account", "Name", "Debit", "Credit"],
        stmts.trialBalance.rows.map((r) => [
          r.code,
          r.name,
          csvDollars(r.debitCents),
          csvDollars(r.creditCents),
        ]),
      ),
    },
    {
      name: `general-ledger-${to}.csv`,
      content: toCsv(
        ["Entry", "Date", "Memo", "Account", "Name", "Debit", "Credit", "Job", "Cost code"],
        gl.map((r) => [
          r.entryId,
          r.entryDate,
          r.memo,
          r.accountCode,
          r.accountName,
          csvDollars(r.debitCents),
          csvDollars(r.creditCents),
          r.jobNo ?? "",
          r.costCode ?? "",
        ]),
      ),
    },
    {
      name: `profit-and-loss-${to}.csv`,
      content: toCsv(
        ["Section", "Account", "Name", "Amount"],
        [
          ...stmts.pnl.revenue.map((l) => ["Revenue", l.code, l.name, csvDollars(l.amountCents)]),
          ...stmts.pnl.costOfSales.map((l) => ["Cost of sales", l.code, l.name, csvDollars(l.amountCents)]),
          ...stmts.pnl.expenses.map((l) => ["Expenses", l.code, l.name, csvDollars(l.amountCents)]),
          ["Total", "", "Net income", csvDollars(stmts.pnl.netIncomeCents)],
        ],
      ),
    },
    {
      name: `balance-sheet-${to}.csv`,
      content: toCsv(
        ["Section", "Account", "Name", "Amount"],
        [
          ...stmts.balanceSheet.assets.map((l) => ["Assets", l.code, l.name, csvDollars(l.amountCents)]),
          ...stmts.balanceSheet.liabilities.map((l) => ["Liabilities", l.code, l.name, csvDollars(l.amountCents)]),
          ...stmts.balanceSheet.equity.map((l) => ["Equity", l.code, l.name, csvDollars(l.amountCents)]),
          ["Equity", "", "Current period earnings", csvDollars(stmts.balanceSheet.currentEarningsCents)],
          ["Total", "", "Assets", csvDollars(stmts.balanceSheet.assetsCents)],
          ["Total", "", "Liabilities + equity", csvDollars(stmts.balanceSheet.liabilitiesAndEquityCents)],
        ],
      ),
    },
    {
      name: `ar-aging-${to}.csv`,
      content: toCsv(
        ["Bucket", "Amount"],
        [
          ...aging.buckets.map((b) => [b.label, csvDollars(b.amountCents)] as (string | number)[]),
          ["Retainage held", csvDollars(aging.retainageCents)],
          ["Total", csvDollars(aging.totalCents)],
        ],
      ),
    },
    {
      name: `wip-schedule-${to}.csv`,
      content: toCsv(
        ["Job", "Name", "Contract", "Costs to date", "Earned", "Billed", "Underbilled", "Overbilled"],
        [
          ...wip.rows.map((r) => [
            r.jobNo,
            r.name,
            csvDollars(r.contractCents),
            csvDollars(r.costsCents),
            csvDollars(r.wip.earnedRevenueCents),
            csvDollars(r.billedCents),
            csvDollars(r.wip.underbilledCents),
            csvDollars(r.wip.overbilledCents),
          ]),
          [
            "Total",
            "",
            csvDollars(wip.totals.contractCents),
            csvDollars(wip.totals.costsCents),
            csvDollars(wip.totals.earnedCents),
            csvDollars(wip.totals.billedCents),
            csvDollars(wip.totals.underbilledCents),
            csvDollars(wip.totals.overbilledCents),
          ],
        ],
      ),
    },
  ];

  const zip = buildZip(entries);
  return new NextResponse(Buffer.from(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="cpa-pack-${to}.zip"`,
    },
  });
});
