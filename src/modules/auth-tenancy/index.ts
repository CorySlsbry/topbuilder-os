// auth-tenancy module — public port.
//
// Identity lives in an httpOnly cookie (uid + aal only). Authorization —
// tenant, role, departments — is resolved FRESH from the directory on every
// request (memberships / member_department_access under RLS), never from a
// cookie or token claim. aal2 comes only from a verified second factor.
import "server-only";
import { env } from "@/env";
import { verifyIdToken } from "./internal/identity-platform";
import { seedNahbChart } from "@/modules/ledger";
import { getSession } from "./internal/session";
import {
  bumpEpoch,
  currentEpoch,
  listMemberships,
  provisionTenant,
  resolveScope,
  type Membership,
  type ResolvedScope,
  type Role,
} from "./internal/directory";
import { ensureDepartments } from "./internal/team";
import { AuthError, checkScope, type ScopeRequirements } from "./internal/guards";

export {
  AuthError,
  BOOKS_ROLES,
  checkScope,
  holdsDepartments,
  WRITE_ROLES,
} from "./internal/guards";
export type { Membership, ResolvedScope, Role, ScopeRequirements };

/**
 * The public demo principal — the no-login tour of the fictional Desert Aire
 * tenant. Seated by migration 0039 as an ordinary `viewer` membership with
 * every department grant, so it reads the whole product (including the money
 * screens, which is the entire point) and writes nothing.
 */
export const DEMO_UID = "demo:public";

export interface Principal {
  uid: string;
  email?: string;
  aal: "aal1" | "aal2";
}

/**
 * Sign-in methods this application accepts. Extend DELIBERATELY — every entry
 * is a way in. Enabling a provider in the GCP console is not enough, and that
 * is the point.
 */
const ALLOWED_SIGN_IN_PROVIDERS = new Set(["password"]);

/** The authenticated principal, or 401. Authentication only — no authz. */
export async function requireAuth(): Promise<Principal> {
  const session = await getSession();
  if (!session.uid) throw new AuthError(401, "unauthenticated");
  await assertNotRevoked(session.uid, session.epoch);
  return { uid: session.uid, email: session.email, aal: session.aal ?? "aal1" };
}

/**
 * A stateless cookie proves who minted it, not that it should still be
 * honoured. Compare the epoch it carries against the user's current one, so
 * logout and offboarding actually END a session instead of merely deleting the
 * client's copy of it. Fails CLOSED — an unreadable epoch is a revoked session.
 */
async function assertNotRevoked(uid: string, epoch: number | undefined): Promise<void> {
  if (epoch === undefined) throw new AuthError(401, "session_revoked");
  let current: number;
  try {
    current = await currentEpoch(uid);
  } catch {
    throw new AuthError(401, "session_revoked");
  }
  if (current !== epoch) throw new AuthError(401, "session_revoked");
}

/**
 * The full authorization gate for tenant surfaces: authenticate, re-verify
 * membership in the active tenant, resolve role + department grants from the
 * directory, then enforce `req`. Every data route goes through this.
 */
export async function requireScope(
  req: ScopeRequirements = {},
): Promise<ResolvedScope & { aal: "aal1" | "aal2" }> {
  const session = await getSession();
  if (!session.uid) throw new AuthError(401, "unauthenticated");
  await assertNotRevoked(session.uid, session.epoch);
  if (!session.activeTenantId) throw new AuthError(403, "no_active_tenant");

  const resolved = await resolveScope(session.uid, session.activeTenantId);
  if (!resolved) throw new AuthError(403, "not_a_member");

  // The demo principal is pinned to `viewer` HERE, not merely in the row that
  // seats it. The DB row is the normal control; this is the one that survives
  // a future migration, script, or misclick promoting that membership. Its
  // read access still comes from real department grants, so the demo shows
  // the whole product — it just cannot be talked into a writing role.
  const scope =
    resolved.uid === DEMO_UID ? { ...resolved, role: "viewer" as const } : resolved;

  const aal = session.aal ?? "aal1";
  checkScope(scope, aal, req);
  return { ...scope, aal };
}

export async function myMemberships(): Promise<Membership[]> {
  const { uid } = await requireAuth();
  return listMemberships(uid);
}

/**
 * Fresh-start signup: new tenant + owner membership; becomes active.
 * Day-one onboarding seeds the NAHB chart of accounts immediately — a tenant
 * can post its first cost the minute it exists (no empty-ledger dead end).
 */
export async function signup(name: string, slug: string): Promise<string> {
  const { uid } = await requireAuth();
  const tenantId = await provisionTenant(uid, name, slug);
  await seedNahbChart({ uid, tenantId });
  await ensureDepartments({ uid, tenantId });
  // Start the 30-day trial the moment the tenant exists (matches the offer).
  await (await import("@/lib/db/tenant")).withTenant({ uid, tenantId }, async (c) => {
    await c.query(
      `INSERT INTO subscriptions (tenant_id, plan, seat_cap, status, trial_ends_at)
       VALUES ($1,'crew',10,'trialing', now() + interval '30 days')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
  });
  const session = await getSession();
  session.activeTenantId = tenantId;
  await session.save();
  return tenantId;
}

/** Switch the acting tenant — membership verified before the pointer moves. */
export async function selectTenant(tenantId: string): Promise<void> {
  const { uid } = await requireAuth();
  const scope = await resolveScope(uid, tenantId);
  if (!scope) throw new AuthError(403, "not_a_member");
  const session = await getSession();
  session.activeTenantId = tenantId;
  await session.save();
}

/**
 * Dev-only login (email → deterministic uid). Hard-disabled outside
 * AUTH_MODE=dev, and AUTH_MODE=dev itself refuses to run in production.
 * The Identity Platform provider (ID-token verify + TOTP → aal2) replaces
 * this once GCP is provisioned — see docs/NEEDS-CORY.md.
 */
export async function devLogin(email: string): Promise<Principal> {
  if (env().AUTH_MODE !== "dev" || env().NODE_ENV === "production") {
    throw new AuthError(401, "dev_login_disabled");
  }
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new AuthError(401, "invalid_email");
  }
  const session = await getSession();
  session.uid = `dev:${normalized}`;
  session.email = normalized;
  session.aal = "aal1"; // dev logins NEVER claim a second factor
  session.activeTenantId = undefined;
  session.epoch = await currentEpoch(session.uid);
  await session.save();
  return { uid: session.uid, email: normalized, aal: "aal1" };
}

/**
 * Identity Platform login: exchange a verified ID token for our session.
 *
 * The ID token proves WHO you are and HOW STRONGLY you proved it, and that is
 * all we take from it. Tenant, role and departments are still resolved fresh
 * from the directory on every request, so a token cannot grant scope — the
 * same rule that already applies to the dev path.
 *
 * The session is re-minted from scratch (no merge into an existing session),
 * so signing in as a different user can never inherit the previous user's
 * activeTenantId — a session-fixation shape that is easy to leave behind when
 * you only overwrite the fields you happen to think about.
 */
export async function identityLogin(idToken: string): Promise<Principal> {
  if (env().AUTH_MODE !== "identity-platform") {
    throw new AuthError(401, "identity_login_disabled");
  }
  let verified;
  try {
    verified = await verifyIdToken(idToken);
  } catch {
    // Opaque on purpose — see identity-platform.ts.
    throw new AuthError(401, "invalid_credentials");
  }

  // The token proving WHO you are is not the same as this application
  // agreeing to let that identity in.
  //
  // /api/auth/config serves the Identity Platform Web API key to anyone (by
  // design — it identifies the project and grants nothing on its own), and
  // Identity Platform's Email/Password provider permits self-service
  // accounts:signUp. So anyone can mint a genuine, correctly-signed ID token
  // for a throwaway address. RLS keeps them out of everyone else's data, but
  // without these two checks that token is a session here.
  //
  // Pinning the provider is the load-bearing half: the day anonymous auth or
  // a federated IdP is switched on in the GCP console — a click, in a
  // different system, by someone not reading this file — the allowlist is
  // what stops it from silently becoming an authentication bypass.
  if (!ALLOWED_SIGN_IN_PROVIDERS.has(verified.signInProvider ?? "")) {
    throw new AuthError(401, "invalid_credentials");
  }
  if (!verified.emailVerified) {
    // Distinct code: this one the user can actually fix, and telling them to
    // check their inbox is not an information leak — they already proved they
    // control the password for this address.
    throw new AuthError(403, "email_not_verified");
  }

  const session = await getSession();
  session.destroy();
  const fresh = await getSession();
  fresh.uid = verified.uid;
  fresh.email = verified.email;
  fresh.aal = verified.aal;
  fresh.activeTenantId = undefined;
  // Stamp the CURRENT revocation epoch. Every later request compares against
  // it, so a prior logout cannot be undone by replaying an older cookie.
  fresh.epoch = await currentEpoch(verified.uid);
  await fresh.save();
  return { uid: verified.uid, email: verified.email, aal: verified.aal };
}

export async function logout(): Promise<void> {
  const session = await getSession();
  // Bump FIRST: destroying the cookie only removes the client's copy, and a
  // copy taken before this call would otherwise stay valid for the full TTL.
  if (session.uid) await bumpEpoch(session.uid).catch(() => {});
  session.destroy();
}

// ---------------------------------------------------------- advisor invites
// S21: the CPA channel. An owner mints a one-time code; the CPA logs in and
// redeems it to join as 'bookkeeper' (read + financials, no destructive
// surface). Redemption is SECURITY DEFINER — the CPA has no membership yet.
export async function createAdvisorInvite(): Promise<string> {
  // A live invite code is standing access to the books for someone outside
  // the company. Minting one takes a second factor.
  const scope = await requireScope({ roles: ["owner", "admin"], aal2: true });
  const { withTenant } = await import("@/lib/db/tenant");
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ code: string }>(
      `INSERT INTO advisor_invites (tenant_id, created_by) VALUES ($1, $2)
       RETURNING code`,
      [scope.tenantId, scope.uid],
    );
    return rows[0]!.code;
  });
}

export async function redeemAdvisorInvite(code: string): Promise<string | null> {
  const { uid } = await requireAuth();
  const { getPool } = await import("@/lib/db/pool");
  const { rows } = await getPool().query<{ tenant: string | null }>(
    "SELECT app.redeem_advisor_invite($1, $2) AS tenant",
    [code, uid],
  );
  return rows[0]?.tenant ?? null;
}

export {
  addMember,
  createDepartment,
  deleteDepartment,
  isProtectedDepartment,
  listTeam,
  renameDepartment,
  setMemberDepartments,
  setMemberRole,
  STANDARD_DEPARTMENTS,
} from "./internal/team";
export type { TeamMember } from "./internal/team";

/**
 * Start the public read-only demo: find the demo tenant, confirm the demo
 * principal really is seated there as a viewer, and mint a session.
 *
 * Returns null (→ 503) rather than improvising if the membership isn't
 * present — a demo that silently half-works is worse than an honest "not
 * available", and this is the surface strangers meet first.
 */
export async function startDemoSession(): Promise<{ tenantName: string } | null> {
  const memberships = await listMemberships(DEMO_UID);
  const demo = memberships[0];
  if (!demo || demo.role !== "viewer") return null;

  const session = await getSession();
  session.destroy();
  const fresh = await getSession();
  fresh.uid = DEMO_UID;
  fresh.email = undefined;
  fresh.aal = "aal1"; // a tour never claims a second factor
  fresh.activeTenantId = demo.tenantId;
  fresh.epoch = await currentEpoch(DEMO_UID);
  await fresh.save();
  return { tenantName: demo.tenantName };
}
