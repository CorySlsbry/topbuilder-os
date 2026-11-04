import "server-only";
import { checkBudget, finishRun, propose, startRun, type AgentActorScope } from "@/modules/agents";
import { pickLeastLoaded } from "./balance";
import { unassignedWithLoads } from "./store";

// The Dispatcher (deterministic): every unassigned scheduled appointment in
// the next 14 days gets a least-loaded-worker proposal. No money moves, so
// dispatch.assign is NOT always-HITL: in "Ask first" it queues, in "Auto"
// it executes immediately — and it is UNDOABLE (undo = unassign).

export interface DispatchRunReport {
  runId: string;
  scanned: number;
  proposed: number;
  executed: number;
  duplicates: number;
}

export async function runDispatchAgent(scope: AgentActorScope): Promise<DispatchRunReport> {
  await checkBudget(scope);
  const runId = await startRun(scope, "dispatch", "manual");
  const { unassigned, workers, loadByWorkerDay } = await unassignedWithLoads(scope);

  let proposed = 0;
  let executed = 0;
  let duplicates = 0;
  for (const appt of unassigned) {
    const pick = pickLeastLoaded(
      workers.map((w) => ({ workerId: w.id, name: w.name })),
      new Map(
        workers.map((w) => [w.id, loadByWorkerDay.get(`${w.id}|${appt.day}`) ?? 0]),
      ),
    );
    if (!pick) break; // no workers yet — nothing to propose
    const r = await propose(scope, {
      agentKey: "dispatch",
      kind: "dispatch.assign",
      payload: {
        appointmentId: appt.id,
        workerId: pick.workerId,
        workerName: pick.name,
        jobNo: appt.jobNo,
        jobName: appt.jobName,
        day: appt.day,
      },
      figures: [appt.jobNo],
      idempotencyKey: `disp:${appt.id}:${pick.workerId}`,
      confidence: 75,
      runId,
    });
    if (r.duplicate) duplicates++;
    else if (r.status === "executed") executed++;
    else proposed++;
    // Keep in-run loads honest so two same-day appointments spread out.
    loadByWorkerDay.set(
      `${pick.workerId}|${appt.day}`,
      (loadByWorkerDay.get(`${pick.workerId}|${appt.day}`) ?? 0) + 1,
    );
  }

  await finishRun(scope, runId, {
    ok: true,
    output: { proposed, executed, duplicates },
    costMicroUsd: 0,
  });
  return { runId, scanned: unassigned.length, proposed, executed, duplicates };
}
