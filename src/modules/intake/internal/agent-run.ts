import "server-only";
import { checkBudget, finishRun, propose, startRun, type AgentActorScope } from "@/modules/agents";
import { listIntake, openSlots } from "./store";
import { pickSlot } from "./slots";

// The Receptionist (deterministic): every NEW intake request gets a
// booking proposal at the earliest REAL open slot matching the caller's
// preference. Booking is outward-facing but not money and fully undoable
// -> not always-HITL: "Ask first" queues, "Auto" books.

export interface IntakeRunReport {
  runId: string;
  scanned: number;
  proposed: number;
  executed: number;
  duplicates: number;
  noSlots: number;
}

export async function runIntakeAgent(scope: AgentActorScope): Promise<IntakeRunReport> {
  await checkBudget(scope);
  const runId = await startRun(scope, "booking", "manual");

  const [requests, slots] = await Promise.all([
    listIntake(scope, "new"),
    openSlots(scope, 10),
  ]);

  let proposed = 0;
  let executed = 0;
  let duplicates = 0;
  let noSlots = 0;
  // Track in-run consumption so two requests don't book the same last slot.
  const used = new Map<string, number>();
  for (const req of requests) {
    const available = slots.filter(
      (s) => s.remaining - (used.get(`${s.date}|${s.window}`) ?? 0) > 0,
    );
    const slot = pickSlot(available, req.preferredWindow as "any" | "morning" | "afternoon");
    if (!slot) {
      noSlots++;
      continue;
    }
    const r = await propose(scope, {
      agentKey: "booking",
      kind: "intake.book",
      payload: {
        intakeId: req.id,
        name: req.name,
        description: req.description,
        date: slot.date,
        window: slot.window === "am" ? "morning" : "afternoon",
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      },
      figures: [],
      idempotencyKey: `book:${req.id}`,
      confidence: 80,
      runId,
    });
    if (r.duplicate) duplicates++;
    else if (r.status === "executed") executed++;
    else proposed++;
    used.set(`${slot.date}|${slot.window}`, (used.get(`${slot.date}|${slot.window}`) ?? 0) + 1);
  }

  await finishRun(scope, runId, {
    ok: true,
    output: { proposed, executed, duplicates, noSlots },
    costMicroUsd: 0,
  });
  return { runId, scanned: requests.length, proposed, executed, duplicates, noSlots };
}
