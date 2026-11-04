import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { BillingError } from "./stripe-api";
import { can, missingCapabilities, PLANS, type Capability, type PlanKey } from "./plans";

/**
 * The entitlement gate — the SERVER side of the Light fence.
 *
 * Hiding a nav item is user experience. This is enforcement, and it is the
 * only thing that actually holds: a fenced route must refuse a fenced tenant
 * even when the request is hand-rolled with curl. Same posture as the
 * department walls — the screen is a courtesy, the route is the wall.
 *
 * ⛔ It reads the plan from the DATABASE on every call, never from the
 * session, a cookie, or anything the caller can influence. A tenant's plan is
 * a fact about the subscription row, exactly like `tenant_id` is a fact about
 * the membership row.
 *
 * ⛔ It fails CLOSED in one specific way that matters: an unknown plan string
 * in the column resolves to no capabilities at all rather than to all of them.
 * A migration that widened the CHECK before this file learned the new key must
 * lock people OUT of extras, never let a $99 tenant into the crew tools.
 */

async function planOf(scope: TenantScope): Promise<PlanKey | null> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ plan: string }>("SELECT plan FROM subscriptions");
    const plan = rows[0]?.plan;
    if (!plan) {
      // No subscription row at all — the same posture `enforce_seat_cap` takes
      // (migration 0025): an unbilled tenant is not a fenced tenant. Signup
      // always writes one, so this is the pre-billing legacy path.
      return null;
    }
    return plan in PLANS ? (plan as PlanKey) : ("__unknown__" as PlanKey);
  });
}

/**
 * Refuse unless this tenant's plan includes the capability.
 *
 * 402 rather than 403 on purpose: this is not "you may not", it is "your plan
 * does not cover this", which is a payment-required condition and is what the
 * seat wall already returns. The client renders an upgrade prompt off it.
 */
export async function assertCapability(
  scope: TenantScope,
  capability: Capability,
): Promise<void> {
  const plan = await planOf(scope);
  if (plan === null) return; // no subscription row: unfenced, as with seats
  if (!can(plan, capability)) {
    throw new BillingError(402, `plan_lacks_capability:${capability}`);
  }
}

export interface TenantCapabilities {
  plan: PlanKey | null;
  planName: string | null;
  /** What this plan does NOT include — the client hides these. */
  missing: Capability[];
}

/** For /api/me: lets the shell hide what the routes would refuse anyway. */
export async function tenantCapabilities(scope: TenantScope): Promise<TenantCapabilities> {
  const plan = await planOf(scope);
  if (plan === null) return { plan: null, planName: null, missing: [] };
  const known = plan in PLANS;
  return {
    plan: known ? plan : null,
    planName: known ? PLANS[plan].name : null,
    missing: known ? missingCapabilities(plan) : [],
  };
}
