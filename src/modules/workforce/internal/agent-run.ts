import "server-only";
import { checkBudget, finishRun, propose, startRun, type AgentActorScope } from "@/modules/agents";
import { listPendingWeeks } from "./store";
import { weekStartOf } from "./ot";

// The Workforce agent (deterministic v1): each COMPLETED worker-week of
// pending time becomes a plain-language card — hours, OT, and the burdened
// total, all computed by the S3 money math. Posting moves money (job cost +
// payroll accruals), so time.postWeek is ALWAYS_HITL.

export interface WorkforceRunReport {
  runId: string;
  scanned: number;
  proposed: number;
  duplicates: number;
  heldCurrentWeek: number;
}

export async function runWorkforceAgent(scope: AgentActorScope): Promise<WorkforceRunReport> {
  await checkBudget(scope);
  const runId = await startRun(scope, "workforce", "manual");

  const weeks = await listPendingWeeks(scope);
  // Only completed weeks: proposing mid-week would split the OT calc.
  const currentWeek = weekStartOf(new Date().toISOString().slice(0, 10));
  const ready = weeks.filter((w) => w.weekStart < currentWeek);

  let proposed = 0;
  let duplicates = 0;
  for (const w of ready) {
    const r = await propose(scope, {
      agentKey: "workforce",
      kind: "time.postWeek",
      payload: {
        workerId: w.workerId,
        weekStart: w.weekStart,
        workerName: w.workerName,
        totalHoursX100: w.totalHoursX100,
        otHoursX100: w.otHoursX100,
        totalCents: w.totalCents,
        entryCount: w.entryCount,
        jobNos: w.jobNos,
      },
      figures: [w.totalCents, w.totalHoursX100, w.otHoursX100, w.entryCount],
      idempotencyKey: `wf:week:${w.workerId}:${w.weekStart}:${w.entryCount}:${w.totalCents}`,
      confidence: 90,
      runId,
    });
    if (r.duplicate) duplicates++;
    else proposed++;
  }

  await finishRun(scope, runId, {
    ok: true,
    output: { proposed, duplicates, heldCurrentWeek: weeks.length - ready.length },
    costMicroUsd: 0,
  });
  return {
    runId,
    scanned: weeks.length,
    proposed,
    duplicates,
    heldCurrentWeek: weeks.length - ready.length,
  };
}
