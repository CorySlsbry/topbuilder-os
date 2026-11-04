import { NextResponse } from "next/server";
import { holdsDepartments, requireScope, AuthError } from "@/modules/auth-tenancy";
import {
  computeJobProfit,
  crewProfitView,
  explainJobProfit,
  getJobCosting,
  getJobVisibility,
} from "@/modules/job-costing";
import { listPendingLaborByJob } from "@/modules/workforce";
import { route } from "@/lib/http/route";
import { formatMoney } from "@/lib/money/cents";

export const dynamic = "force-dynamic";

/**
 * "What did this job actually make me?"
 *
 * A SEPARATE route from /costing rather than a flag on it, so /costing keeps
 * its single unambiguous financials wall on line one. This one has two
 * audiences and therefore two answers, which is exactly the kind of thing that
 * should not be bolted onto a route whose authz is currently one line.
 *
 * ── The two layers ────────────────────────────────────────────────────────
 * Someone WITH the financials wall gets the whole picture. Someone without it
 * gets the narrowed `crewProfitView` — but only if the shop switched that on,
 * and otherwise the same 403 every other financials route gives.
 *
 * The wall question is asked with `holdsDepartments`, the exact predicate
 * `checkScope` uses. Restating it here would eventually drift, and the drift
 * that matters is forgetting the owner/admin implicit grant — which would hand
 * an owner the redacted crew view of their own job.
 */
export const GET = route(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope();
    const { id } = await ctx.params;

    const full = holdsDepartments(scope, ["financials"]);
    if (!full) {
      const { crewSeesProfit } = await getJobVisibility(scope);
      // Off is the default and the safe answer. Same code and shape as any
      // other financials refusal — a distinct error here would tell someone
      // without access that the setting exists and is switched off, which is
      // itself a small fact about the shop.
      if (!crewSeesProfit) throw new AuthError(403, "department_forbidden");
    }

    const costing = await getJobCosting(scope, id);

    // ⛔ Compute burden for EVERY pending entry and then pick this job out.
    //
    // The obvious optimisation — filter the time entries to this job first —
    // is wrong. Overtime is a property of a worker's WEEK: a worker who put 30
    // hours on this job and 15 on another crossed the 40-hour line somewhere,
    // and which hours land at time-and-a-half depends on the whole week in
    // date order. Burden by worker-week first, split by job second, or the
    // number is quietly too low on exactly the busy weeks that matter.
    //
    // The cost is bounded: this reads unposted time only, which is one payroll
    // week, not the job's history.
    const pending = await listPendingLaborByJob(scope);
    const unpostedLaborCents = pending.find((p) => p.jobId === id)?.totalCents ?? 0;

    const profit = computeJobProfit({
      contractCents: costing.contractCents,
      billedCents: costing.billedCents,
      collectedCents: costing.collectedCents,
      postedCostsCents: costing.costsCents,
      unpostedLaborCents,
    });

    const money = (c: number) => `$${formatMoney(c)}`;

    if (!full) {
      // Split the sentence out to the top level so BOTH responses put it in
      // the same place. `crewProfitView` deliberately carries its own explain
      // (the redaction contract covers the prose, not just the keys), but a
      // client that has to look in two places depending on which answer it got
      // will eventually look in the wrong one and render nothing.
      const { explain, ...figures } = crewProfitView(profit, money);
      return NextResponse.json({
        jobId: costing.jobId,
        jobNo: costing.jobNo,
        name: costing.name,
        view: "crew" as const,
        profit: figures,
        explain,
      });
    }

    return NextResponse.json({
      jobId: costing.jobId,
      jobNo: costing.jobNo,
      name: costing.name,
      view: "full" as const,
      profit,
      explain: explainJobProfit(profit, money),
      /**
       * The OTHER gross profit, named so nobody has to guess which is which.
       * WIP earned revenue is driven by the owner's estimate-to-complete, so
       * this figure moves when a guess is edited; `profit` is made only of
       * things that happened. Both are correct answers to different questions,
       * and showing them unlabelled beside each other is how a shop concludes
       * the software cannot add up.
       */
      wip: {
        grossProfitCents: costing.wip.grossProfitCents,
        pctCompleteBps: costing.wip.pctCompleteBps,
        explain: costing.explain.wip,
      },
      unpostedLabor:
        unpostedLaborCents > 0
          ? {
              totalCents: unpostedLaborCents,
              workerCount: pending.find((p) => p.jobId === id)?.workerCount ?? 0,
            }
          : null,
    });
  },
);
