import { type NextRequest, NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import {
  buildZip,
  csvDollars,
  getArAging,
  getStatements,
  toCsv,
  type ZipEntry,
} from "@/modules/reporting";
import {
  getBacklog,
  getCipSchedule,
  getCompletedContracts,
  getRatioPanel,
  listCreditFacilities,
} from "@/modules/job-costing";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The bonding package — one download an owner emails to their surety agent.
 *
 * Everything in it is generated from this shop's own general ledger, which is
 * the whole point: the schedules AGREE WITH THE BOOKS by construction, and
 * that agreement is normally what costs a contractor two weeks of their CPA's
 * time to establish.
 *
 * ⛔ THE README IS PART OF THE PACKAGE, NOT A COURTESY. It states the method
 * (cost-to-cost percentage of completion), states plainly whether the
 * schedule ties to the trial balance, and says in writing that this is not a
 * CPA-prepared financial statement and asserts no bonding capacity. An
 * underwriter who finds an unstated assumption stops trusting the whole file;
 * one who finds them all listed on the first page reads the rest faster.
 */
export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({ departments: ["financials"] });
  await assertCapability(scope, "bonding");
  const p = req.nextUrl.searchParams;
  const to = p.get("to") ?? new Date().toISOString().slice(0, 10);
  const from = p.get("from") ?? `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
  if (!DATE.test(to) || !DATE.test(from)) return errorResponse(400, "invalid_date");

  const [cip, completed, backlog, ratios, facilities, stmts, aging] = await Promise.all([
    getCipSchedule(scope, to),
    getCompletedContracts(scope, from, to),
    getBacklog(scope),
    getRatioPanel(scope, to),
    listCreditFacilities(scope),
    getStatements(scope, { from, to }),
    getArAging(scope, to),
  ]);

  const bps = (n: number | null) => (n === null ? "n/a" : (n / 100).toFixed(2) + "%");
  const x = (n: number | null) => (n === null ? "n/a" : (n / 10_000).toFixed(2) + "x");

  const entries: ZipEntry[] = [
    {
      name: "README.txt",
      content: [
        `BONDING PACKAGE — as of ${to}`,
        ``,
        `Prepared from the contractor's own general ledger by Top Builder OS.`,
        ``,
        `METHOD`,
        `  Percent complete is measured cost-to-cost: costs incurred to date`,
        `  divided by (costs to date + the estimate to complete). Earned revenue`,
        `  is the contract price times that percentage, capped at the contract.`,
        `  The estimate to complete is supplied by the contractor and is the one`,
        `  number on these schedules that is not derived from a posted`,
        `  transaction.`,
        ``,
        `CONTRACT VALUES`,
        `  Contract price includes APPROVED change orders only. Change orders`,
        `  that are drafted or sent but not approved are disclosed in their own`,
        `  column and are not included in any contract total, any earned`,
        `  revenue, or any gross profit figure.`,
        ``,
        `OVER- AND UNDER-BILLINGS`,
        `  Reported separately and never netted against each other.`,
        `  Costs and earnings in excess of billings: ${csvDollars(cip.totals.underbilledCents)}`,
        `  Billings in excess of costs and earnings: ${csvDollars(cip.totals.overbilledCents)}`,
        ``,
        `TIE-OUT TO THE TRIAL BALANCE`,
        cip.tieOut.tied
          ? `  These schedules TIE to the general ledger. Account 1265 and account`
          : `  ⚠ These schedules DO NOT currently tie to the general ledger.`,
        cip.tieOut.tied
          ? `  2480 carry the balances shown above.`
          : `  Ledger 1265: ${csvDollars(cip.tieOut.ledgerUnderbilledCents)} (schedule: ${csvDollars(cip.totals.underbilledCents)})`,
        cip.tieOut.tied
          ? `  Last percentage-of-completion adjustment posted: ${cip.tieOut.lastAdjustmentOn ?? "n/a"}`
          : `  Ledger 2480: ${csvDollars(cip.tieOut.ledgerOverbilledCents)} (schedule: ${csvDollars(cip.totals.overbilledCents)})`,
        cip.tieOut.tied
          ? ``
          : `  A percentage-of-completion adjusting entry has not been posted for`,
        cip.tieOut.tied ? `` : `  this date. Post it and regenerate this package.`,
        ``,
        `WHAT THIS IS NOT`,
        `  This is not a CPA-prepared financial statement. It has not been`,
        `  compiled, reviewed or audited. It asserts no bonding capacity — the`,
        `  multiple applied to working capital and tangible net worth is the`,
        `  underwriter's judgement and appears nowhere in this package.`,
        ``,
        `CONTENTS`,
        `  contracts-in-progress   the WIP schedule, one row per open contract`,
        `  completed-contracts     finished jobs, estimated vs actual gross profit`,
        `  backlog                 signed work not yet earned`,
        `  surety-ratios           working capital, leverage, tangible net worth`,
        `  credit-facilities       bank lines and term debt`,
        `  balance-sheet / income-statement / trial-balance`,
        `  ar-aging                receivables, with retainage identified`,
        ``,
        cip.explain,
        ``,
        completed.explain,
      ].join("\n"),
    },
    {
      name: `contracts-in-progress-${to}.csv`,
      content: toCsv(
        [
          "Job #", "Contract", "Owner / GC", "Type", "Bonded", "Bond #", "Surety",
          "Started", "Est. completion", "Contract price (incl approved COs)",
          "PENDING change orders (not included)", "Estimated total cost",
          "Estimated gross profit", "Estimated margin", "% complete",
          "Costs to date", "Earned revenue", "Gross profit earned",
          "Billed to date", "Retainage held",
          "Costs & earnings in excess of billings", "Billings in excess of costs",
          "Remaining to bill", "Gross profit remaining", "Notes",
        ],
        [
          ...cip.rows.map((r) => [
            r.jobNo, r.name, r.ownerName ?? r.customerName, r.contractType,
            r.bonded ? "yes" : "no", r.bondNumber ?? "", r.suretyName ?? "",
            r.startedOn ?? "", r.estCompletionOn ?? "",
            csvDollars(r.contractCents),
            csvDollars(r.pendingChangeOrderCents),
            csvDollars(r.estTotalCostCents),
            csvDollars(r.estGrossProfitCents),
            bps(r.estGrossMarginBps),
            (r.pctCompleteBps / 100).toFixed(2) + "%",
            csvDollars(r.costsToDateCents),
            csvDollars(r.earnedRevenueCents),
            csvDollars(r.grossProfitEarnedCents),
            csvDollars(r.billedToDateCents),
            csvDollars(r.retainageHeldCents),
            csvDollars(r.underbilledCents),
            csvDollars(r.overbilledCents),
            csvDollars(r.remainingToBillCents),
            csvDollars(r.grossProfitRemainingCents),
            [
              r.flags.lossJob ? "PROJECTED LOSS" : "",
              r.flags.staleEtc ? "estimate to complete is over 30 days old" : "",
              r.flags.materialPendingCos ? "material pending change orders" : "",
              r.flags.billedPastContract ? "billed past contract" : "",
            ].filter(Boolean).join("; "),
          ] as (string | number)[]),
          [
            "", "TOTAL", "", "", "", "", "", "", "",
            csvDollars(cip.totals.contractCents),
            csvDollars(cip.totals.pendingChangeOrderCents),
            csvDollars(cip.totals.estTotalCostCents),
            csvDollars(cip.totals.estGrossProfitCents),
            "", "",
            csvDollars(cip.totals.costsToDateCents),
            csvDollars(cip.totals.earnedRevenueCents),
            csvDollars(cip.totals.grossProfitEarnedCents),
            csvDollars(cip.totals.billedToDateCents),
            csvDollars(cip.totals.retainageHeldCents),
            csvDollars(cip.totals.underbilledCents),
            csvDollars(cip.totals.overbilledCents),
            "", "", "",
          ] as (string | number)[],
        ],
      ),
    },
    {
      name: `completed-contracts-${from}-to-${to}.csv`,
      content: toCsv(
        [
          "Job #", "Contract", "Customer", "Completed", "Bonded",
          "Final contract", "Final cost", "Actual gross profit", "Actual margin",
          "Estimated GP at award", "Estimated GP at last review",
          "Fade vs award", "Fade vs award %", "Fade vs last review",
          "WIP reviews on file",
        ],
        [
          ...completed.rows.map((r) => [
            r.jobNo, r.name, r.customerName, r.completedOn ?? "", r.bonded ? "yes" : "no",
            csvDollars(r.finalContractCents),
            csvDollars(r.finalCostCents),
            csvDollars(r.actualGrossProfitCents),
            bps(r.actualGrossMarginBps),
            r.estGrossProfitAtAwardCents === null ? "no budget on file" : csvDollars(r.estGrossProfitAtAwardCents),
            r.estGrossProfitAtLastSnapshotCents === null ? "no review on file" : csvDollars(r.estGrossProfitAtLastSnapshotCents),
            r.fadeFromAwardCents === null ? "n/a" : csvDollars(r.fadeFromAwardCents),
            bps(r.fadeFromAwardBps),
            r.fadeFromLastSnapshotCents === null ? "n/a" : csvDollars(r.fadeFromLastSnapshotCents),
            r.snapshotCount,
          ] as (string | number)[]),
          [
            "", "TOTAL", "", "", "", "", "", "", "", "", "",
            csvDollars(completed.summary.totalFadeCents),
            bps(completed.summary.weightedFadeBps),
            "", "",
          ] as (string | number)[],
        ],
      ),
    },
    {
      name: `backlog-${to}.csv`,
      content: toCsv(
        ["Job #", "Contract", "Customer", "Status", "Contract price", "Revenue remaining", "Gross profit remaining", "Started", "Est. completion", "Bonded"],
        [
          ...backlog.rows.map((r) => [
            r.jobNo, r.name, r.customerName, r.status,
            csvDollars(r.contractCents),
            csvDollars(r.remainingRevenueCents),
            csvDollars(r.remainingGrossProfitCents),
            r.startedOn ?? "", r.estCompletionOn ?? "", r.bonded ? "yes" : "no",
          ] as (string | number)[]),
          [
            "", "TOTAL", "", "",
            csvDollars(backlog.totals.contractCents),
            csvDollars(backlog.totals.remainingRevenueCents),
            csvDollars(backlog.totals.remainingGrossProfitCents),
            "", "", "",
          ] as (string | number)[],
        ],
      ),
    },
    {
      name: `surety-ratios-${to}.csv`,
      content: toCsv(
        ["Measure", "Value", "How it is computed"],
        [
          ["Working capital", csvDollars(ratios.ratios.workingCapitalCents), "current assets less current liabilities"],
          ["Current ratio", x(ratios.ratios.currentRatioBps), "current assets / current liabilities"],
          ["Debt to equity", x(ratios.ratios.debtToEquityBps), "total liabilities / equity"],
          ["Tangible net worth", csvDollars(ratios.ratios.tangibleNetWorthCents), "equity less intangibles and related-party balances"],
          ["Revenue to working capital", x(ratios.ratios.revenueToWorkingCapitalBps), "trailing revenue / working capital"],
          ["Days in receivables", ratios.ratios.daysInAr ?? "n/a", "AR (excluding retainage) / revenue x days"],
          ["Underbillings as % of equity", bps(ratios.ratios.underbillingsToEquityBps), "costs in excess of billings / equity"],
          ["", "", ""],
          ["Current assets", csvDollars(ratios.inputs.currentAssetsCents), ""],
          ["Current liabilities", csvDollars(ratios.inputs.currentLiabilitiesCents), ""],
          ["Total assets", csvDollars(ratios.inputs.totalAssetsCents), ""],
          ["Total liabilities", csvDollars(ratios.inputs.totalLiabilitiesCents), ""],
          ["Equity", csvDollars(ratios.inputs.equityCents), ""],
          ["Intangible and related-party", csvDollars(ratios.inputs.intangibleAndRelatedPartyCents), ""],
          ["Trailing revenue", csvDollars(ratios.inputs.revenueCents), `${ratios.inputs.periodDays} days to ${to}`],
          ["", "", ""],
          [
            "Accounts classified by the accountant",
            ratios.classified.length,
            ratios.unclassified
              ? "NONE — every asset is being treated as current, which is usually wrong"
              : ratios.classified.map((a) => `${a.code} ${a.name} = ${a.suretyClass}`).join("; "),
          ],
        ] as (string | number)[][],
      ),
    },
    {
      name: `credit-facilities-${to}.csv`,
      content: toCsv(
        ["Lender", "Kind", "Limit", "Balance", "Available", "Rate", "Matures", "Personally guaranteed", "Notes"],
        facilities.map((f) => [
          f.lender, f.kind,
          csvDollars(f.limitCents), csvDollars(f.balanceCents),
          csvDollars(f.limitCents - f.balanceCents),
          f.rateBps === null ? "" : (f.rateBps / 100).toFixed(2) + "%",
          f.maturesOn ?? "", f.personallyGuaranteed ? "yes" : "no", f.notes,
        ] as (string | number)[]),
      ),
    },
    {
      name: `balance-sheet-${to}.csv`,
      content: toCsv(
        ["Section", "Account", "Name", "Amount"],
        [
          ...stmts.balanceSheet.assets.map((r) => ["Assets", r.code, r.name, csvDollars(r.amountCents)] as (string | number)[]),
          ["Assets", "", "TOTAL ASSETS", csvDollars(stmts.balanceSheet.assetsCents)],
          ...stmts.balanceSheet.liabilities.map((r) => ["Liabilities", r.code, r.name, csvDollars(r.amountCents)] as (string | number)[]),
          ["Liabilities", "", "TOTAL LIABILITIES", csvDollars(stmts.balanceSheet.liabilitiesCents)],
          ...stmts.balanceSheet.equity.map((r) => ["Equity", r.code, r.name, csvDollars(r.amountCents)] as (string | number)[]),
          ["Equity", "", "Current period earnings", csvDollars(stmts.balanceSheet.currentEarningsCents)],
          ["Equity", "", "TOTAL EQUITY", csvDollars(stmts.balanceSheet.equityCents)],
          // An underwriter checks this before reading anything else.
          ["", "", stmts.balanceSheet.ties ? "Balance sheet BALANCES" : "⚠ BALANCE SHEET DOES NOT BALANCE", csvDollars(stmts.balanceSheet.liabilitiesAndEquityCents)],
        ],
      ),
    },
    {
      name: `trial-balance-${to}.csv`,
      content: toCsv(
        ["Account", "Name", "Debit", "Credit"],
        stmts.trialBalance.rows.map((r) => [
          r.code, r.name, csvDollars(r.debitCents), csvDollars(r.creditCents),
        ] as (string | number)[]),
      ),
    },
    {
      name: `ar-aging-${to}.csv`,
      content: toCsv(
        ["Bucket", "Amount"],
        [
          ...aging.buckets.map((b) => [b.label, csvDollars(b.amountCents)] as (string | number)[]),
          ["Retainage held (not past due)", csvDollars(aging.retainageCents)],
          ["Total", csvDollars(aging.totalCents)],
        ],
      ),
    },
  ];

  const zip = buildZip(entries);
  return new NextResponse(new Uint8Array(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="bonding-package-${to}.zip"`,
      "cache-control": "no-store",
    },
  });
});
