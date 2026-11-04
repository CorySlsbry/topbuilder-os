import { NextResponse } from "next/server";
import { requireAuth } from "@/modules/auth-tenancy";
import { getLirCohorts, isPlatformOperator, LIR_TARGET_BPS } from "@/modules/reporting";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

// Platform-operator only: anonymous per-cohort LIR aggregates (no tenant
// data). Gated by the PLATFORM_OPERATOR_UIDS allowlist — a 404 (not 403)
// so the endpoint's existence is not advertised.
export const GET = route(async () => {
  const session = await requireAuth();
  if (!isPlatformOperator(session.uid)) return errorResponse(404, "not_found");
  const cohorts = await getLirCohorts();
  return NextResponse.json({ cohorts, targetBps: LIR_TARGET_BPS });
});
