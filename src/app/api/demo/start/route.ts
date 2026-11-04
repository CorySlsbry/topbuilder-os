import { NextResponse } from "next/server";
import { startDemoSession } from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * The no-login tour. Mints a session for the read-only demo principal on the
 * fictional Desert Aire tenant, then the visitor browses the real product.
 *
 * Why this is safe to expose:
 *   - the principal is a `viewer` with department grants — it reads
 *     everything and is excluded from every write gate (BOOKS_ROLES /
 *     WRITE_ROLES), which a structural test now holds in place;
 *   - requireScope PINS it to viewer regardless of what its membership row
 *     says, so a future promotion of that row changes nothing;
 *   - RLS scopes every query to Desert Aire — it cannot see another tenant
 *     even by naming one;
 *   - the tenant is FICTIONAL. Every name, address and dollar in it was
 *     invented for this purpose, so there is no customer data to leak.
 *
 * Rate limited in the proxy under /api/demo (see LIMITS) — this mints a
 * session, and anything that mints sessions gets a ceiling.
 */
export const POST = route(async () => {
  const started = await startDemoSession();
  if (!started) return errorResponse(503, "demo_unavailable");
  return NextResponse.json({ ok: true, tenantName: started.tenantName });
});
