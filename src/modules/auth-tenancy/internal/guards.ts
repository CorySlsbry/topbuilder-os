// Pure authorization guards — no I/O, unit-tested exhaustively.
import { HttpError } from "@/lib/http/errors";
import type { ResolvedScope, Role } from "./directory";

export class AuthError extends HttpError {
  constructor(status: 401 | 403 | 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

export interface ScopeRequirements {
  /** Restrict to these roles (e.g. ["owner","admin"]). Empty = any member. */
  roles?: readonly Role[];
  /** Require access to ALL of these department keys. */
  departments?: readonly string[];
  /** Require a verified second factor (financial/HR surfaces). */
  aal2?: boolean;
}

/**
 * The one place scope requirements are checked. Owner/admin implicitly hold
 * every department wall (they administer them); other roles need explicit
 * per-person grants. Throws AuthError(403) — never returns a partial scope.
 */
/**
 * Roles allowed to CHANGE anything.
 *
 * `viewer` is sold as look-don't-touch on the Team screen, and `bookkeeper` is
 * the CPA's read + financials seat. Neither is enforced by RLS — the policies
 * are tenant-scoped, not role-scoped — so before this existed a viewer could
 * POST /api/jobs/[id]/costs and post a material cost straight into the general
 * ledger. Write authorization has to be stated, not assumed default-open.
 *
 * Surfaces where a bookkeeper legitimately writes (period close, journal
 * adjustments) name the roles they accept explicitly instead of using this.
 */
export const WRITE_ROLES = ["owner", "admin", "staff"] as const;

/**
 * Roles that may change MONEY records — WRITE_ROLES plus the bookkeeper.
 *
 * Twelve mutating financial routes shipped with a department requirement and
 * NO role requirement (bank import/reconcile/resolve, bills, vendors,
 * invoicing, pricebook, agent runs). The reason was structural: WRITE_ROLES
 * omits `bookkeeper`, and the CPA legitimately does bank reconciliation — so
 * naming WRITE_ROLES there would have locked the CPA out, and the roles key
 * got dropped instead. The result was that `viewer`, sold on the Team screen
 * as "look, don't touch", could import a bank statement, reconcile an
 * account, create vendors and bills, and issue invoices.
 *
 * This is the set those routes actually meant: everyone but the viewer.
 */
export const BOOKS_ROLES = ["owner", "admin", "staff", "bookkeeper"] as const;

/**
 * Does this scope stand on the far side of a department wall?
 *
 * Extracted because a second caller appeared: `/api/jobs/[id]/profit` shows a
 * different, narrower answer to someone WITHOUT the financials wall instead of
 * refusing them — so it has to ASK the question rather than be stopped by it.
 *
 * ⛔ It must be this exact rule, not a restatement. The owner/admin implicit
 * grant is easy to forget, and forgetting it there would hand the owner the
 * redacted crew view of their own job — a bug that reads as "the feature is
 * broken" rather than as an authz error, and so gets "fixed" by widening
 * something. One rule, two callers.
 */
export function holdsDepartments(
  scope: ResolvedScope,
  departments: readonly string[],
): boolean {
  if (departments.length === 0) return true;
  // Owner/admin implicitly hold every wall — they administer them.
  if (scope.role === "owner" || scope.role === "admin") return true;
  const held = new Set(scope.departments);
  return departments.every((d) => held.has(d));
}

export function checkScope(
  scope: ResolvedScope,
  aal: "aal1" | "aal2",
  req: ScopeRequirements = {},
): void {
  if (req.aal2 && aal !== "aal2") {
    throw new AuthError(403, "aal2_required");
  }
  if (req.roles && req.roles.length > 0 && !req.roles.includes(scope.role)) {
    throw new AuthError(403, "role_forbidden");
  }
  if (req.departments && req.departments.length > 0) {
    if (!holdsDepartments(scope, req.departments)) {
      throw new AuthError(403, "department_forbidden");
    }
  }
}
