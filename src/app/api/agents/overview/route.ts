import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import {
  getDailyCost,
  listActions,
  listDeadLetters,
  listPolicies,
  listPreferences,
} from "@/modules/agents";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const scope = await requireScope();
  await assertCapability(scope, "agents");
  // Every agent surface is filtered by the same `requires` the approval path
  // checks — the payloads carry bank lines, vendor amounts and worker pay.
  const [policies, pending, recent, deadLetters, preferences, cost] = await Promise.all([
    listPolicies(scope),
    listActions(scope, "proposed"),
    listActions(scope),
    listDeadLetters(scope),
    listPreferences(scope),
    getDailyCost(scope),
  ]);
  return NextResponse.json({
    policies,
    pending,
    recent: recent.slice(0, 30),
    deadLetters,
    preferences,
    cost,
  });
});
