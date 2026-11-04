import { NextResponse } from "next/server";
import { myMemberships, requireAuth, requireScope } from "@/modules/auth-tenancy";
import { tenantCapabilities } from "@/modules/billing";
import { unreadCount } from "@/modules/comms";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/** The canonical "who am I" data route — and the go-live 401 probe target.
 *  Includes the ACTIVE tenant scope (role + department walls) so the shell
 *  can hide what this person can't open. Hiding is UX; the server enforces. */
export const GET = route(async () => {
  const principal = await requireAuth();
  const memberships = await myMemberships();
  let scope: { tenantId: string; role: string; departments: string[] } | null = null;
  let inboxUnread = 0;
  // What this tenant's PLAN does not include. Same posture as the department
  // walls above: the shell hides these so nobody clicks into a 402, and the
  // routes refuse them regardless of what the shell decided to draw.
  let missingCapabilities: string[] = [];
  let planName: string | null = null;
  try {
    const s = await requireScope();
    scope = { tenantId: s.tenantId, role: s.role, departments: s.departments };
    // The unread badge rides along on the request the shell already makes,
    // rather than adding a poll of its own to every page. One indexed sum.
    // A failure here must never cost someone their navigation.
    inboxUnread = await unreadCount(s).catch(() => 0);
    // A billing hiccup must not cost someone their navigation either: on a
    // failure the shell shows everything and the routes still hold the line.
    const caps = await tenantCapabilities(s).catch(() => null);
    missingCapabilities = caps?.missing ?? [];
    planName = caps?.planName ?? null;
  } catch {
    scope = null; // no active tenant yet
  }
  return NextResponse.json({
    uid: principal.uid,
    email: principal.email,
    aal: principal.aal,
    memberships,
    scope,
    inboxUnread,
    planName,
    missingCapabilities,
  });
});
