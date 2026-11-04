import "server-only";
import type { TenantScope } from "@/lib/db/tenant";
import { checkScope, type ScopeRequirements } from "@/modules/auth-tenancy";
import { KINDS } from "./registry";

/**
 * Read visibility for agent surfaces.
 *
 * Approving a card is gated by its `KindSpec.requires`. READING one has to be
 * gated by the same thing, because the card's payload IS the protected data:
 * a `bank.categorize` payload carries the raw bank line, an `ap.billDraft`
 * payload carries vendor + amount, a `time.postWeek` payload carries a
 * worker's burdened pay — which /api/workforce/workers refuses that same
 * reader. Before this, /api/agents/overview handed all of it to any member.
 *
 * Deriving read visibility from the same `requires` the approval path uses
 * means these surfaces cannot drift from the REST routes they mirror: add a
 * kind, and its wall comes with it.
 */

/**
 * The scope agent surfaces need: tenant PLUS the authorization facts, which is
 * exactly what `requireScope()` already returns. Carrying aal on the scope
 * rather than as a second parameter keeps every call site honest — you cannot
 * reach these functions holding a bare TenantScope and quietly skip the check.
 */
export type ActorScope = TenantScope & {
  role: Parameters<typeof checkScope>[0]["role"];
  departments: string[];
  aal: "aal1" | "aal2";
};

/** Closes over the actor so the predicates below just ask "may they?". */
export function readerCheck(scope: ActorScope): (req: ScopeRequirements) => void {
  return (req) => checkScope(scope, scope.aal, req);
}

/** True iff this reader could legitimately act on cards of this kind. */
export function canSeeKind(
  check: (req: ScopeRequirements) => void,
  kind: string,
): boolean {
  const spec = KINDS[kind];
  if (!spec) return false; // unknown kind → fail closed, never leak a payload
  try {
    check(spec.requires);
    return true;
  } catch {
    return false;
  }
}

/**
 * True iff this reader can see ANY of an agent's kinds. Used for artifacts
 * tagged to an agent rather than to a kind — dead-letter assessments and
 * learned preference rules both quote the data the agent was working on.
 */
export function canSeeAgent(
  check: (req: ScopeRequirements) => void,
  agentKey: string,
): boolean {
  const kinds = Object.entries(KINDS).filter(([, s]) => s.owner === agentKey);
  if (kinds.length === 0) return false; // no kinds → nothing to justify a read
  return kinds.some(([kind]) => canSeeKind(check, kind));
}
