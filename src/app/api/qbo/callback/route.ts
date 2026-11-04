import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { completeConnection, verifyState } from "@/modules/qbo-bridge";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

// Intuit redirects here after consent. The HMAC state pins the flow to the
// tenant that started it AND the caller must still be an owner/admin of
// that same tenant — a stolen redirect can't attach a realm elsewhere.
export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: ["owner", "admin"] });
  const q = req.nextUrl.searchParams;
  const code = q.get("code");
  const state = q.get("state");
  const realmId = q.get("realmId");
  if (!code || !state || !realmId) return errorResponse(400, "missing_params");
  if (verifyState(state) !== scope.tenantId) return errorResponse(400, "state_tenant_mismatch");
  await completeConnection(scope, code, realmId);
  return NextResponse.redirect(new URL("/accountant?connected=1", req.nextUrl.origin));
});
