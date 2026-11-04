import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import {
  checkBudget,
  finishRun,
  propose,
  recordFailure,
  startRun,
} from "@/modules/agents";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

// The echo agent: the framework's proving harness (and live smoke test).
// mode "money" proposes an ALWAYS_HITL kind; "fail" exercises the 5-try
// dead-letter; "drift" submits a summary with an invented figure so the
// firewall's template fallback can be observed end-to-end.
const Body = z.object({
  note: z.string().max(200).default("hello"),
  variant: z.enum(["write", "money", "fail", "drift"]).default("write"),
  key: z.string().max(100).optional(),
});

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  await assertCapability(scope, "agents");
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const { note, variant, key } = parsed.data;

  await checkBudget(scope);
  const runId = await startRun(scope, "echo", "manual", { note, variant });

  if (variant === "fail") {
    // The real run-loop semantic: ONE run retries internally until the
    // 5-try stop-gap dead-letters it and flips the agent off.
    let r = { deadLettered: false, attempt: 1 };
    while (!r.deadLettered) {
      r = await recordFailure(scope, runId, "echo", "simulated failure");
    }
    return NextResponse.json({ runId, ...r });
  }

  const idempotencyKey = key ?? `echo:${variant}:${note}`;
  const result = await propose(scope, {
    agentKey: "echo",
    kind: variant === "money" ? "echo.money" : "echo.write",
    payload: variant === "money" ? { amount: 12345, note } : { note },
    summary:
      variant === "drift"
        ? `Echo: this note is worth $999.99 somehow — "${note}"`
        : undefined,
    figures: variant === "money" ? [12345] : [],
    idempotencyKey,
    runId,
  });
  await finishRun(scope, runId, { ok: true, output: result, costMicroUsd: 100 });
  return NextResponse.json({ runId, ...result });
});
