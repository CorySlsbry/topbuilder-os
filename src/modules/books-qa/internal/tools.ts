import "server-only";
import type { ScopeRequirements, ResolvedScope } from "@/modules/auth-tenancy";
import { holdsDepartments } from "@/modules/auth-tenancy";
import type { TenantScope } from "@/lib/db/tenant";

/**
 * The closed tool registry for "ask your books".
 *
 * ── Why this is NOT an agent kind ─────────────────────────────────────────
 * `KindSpec` is {owner, alwaysHitl, requires, template, execute, undo} — every
 * field serves propose→approve→execute of a MUTATION. A question has nothing
 * to execute and nothing to undo, and migration 0029 reads that registry as a
 * source of truth for database policy. Wedging a read-only Q&A into it would
 * make both harder to reason about.
 *
 * ── The security shape, stated once ───────────────────────────────────────
 * ⛔ EVERY TOOL'S `requires` MIRRORS ITS REST ROUTE. This is the SEC-001
 * lesson applied per tool: the agent gate once ran on a bare `requireScope()`
 * and became a privilege-escalation path — a viewer could approve a card that
 * posted to the general ledger while the direct route refused them 403.
 * `tools.test.ts` reads the actual route file and asserts the match, so drift
 * fails the build WHEN SOMEBODY EDITS THE ROUTE LATER, which is when it
 * actually happens.
 *
 * ⛔ TWO LAYERS, NOT ONE. The tool list handed to the model is filtered by the
 * caller's scope — a member without the financials wall never learns
 * `cash_plan` exists — AND every dispatch re-checks. Filtering is UX;
 * the check is enforcement. Prompt injection cannot reach past the second one,
 * because the list is computed from server-resolved scope before the first
 * token and every run closes over that scope, with RLS underneath.
 *
 * ⛔ NO SQL TOOL. EVER. Not a "read-only" one, not a "SELECT-only" one. Every
 * tool here is an existing deterministic function that already returns a
 * verified figure and, usually, its own plain-English explanation.
 */

export interface BooksTool {
  name: string;
  /** What it answers, in the words a person would use. Goes to the model. */
  description: string;
  /**
   * ⛔ The authz a caller must hold — IDENTICAL to the REST route named below.
   * Not "similar to". `tools.test.ts` reads that file and compares.
   */
  requires: ScopeRequirements;
  /**
   * The route this mirrors. Load-bearing: it is the thing the test reads.
   * A tool with no equivalent route has no authz to copy and does not belong
   * in this registry.
   */
  mirrors: string;
  /** JSON Schema for the arguments. Model output becomes args ONLY via zod. */
  schema: Record<string, unknown>;
  /** Runs the existing deterministic function. Never composes SQL. */
  run: (scope: TenantScope, args: Record<string, unknown>) => Promise<unknown>;
  /** Where a person can go and check this answer themselves. */
  href: string;
}

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false };

/**
 * The nine. Deliberately few: each one is a question a shop actually asks, and
 * every extra tool is another surface where the model can pick wrong.
 *
 * The `run` functions are imported lazily inside each call rather than at
 * module load, so this registry can be read by tests and by the authz filter
 * without dragging every reporting module into the bundle.
 */
export const TOOLS: BooksTool[] = [
  {
    name: "cash_plan",
    description:
      "The 13-week cash plan: what is signed, what is on the calendar, what is still backlog, and the lowest point in each case.",
    requires: { departments: ["financials"] },
    mirrors: "src/app/api/reports/cash-plan/route.ts",
    schema: NO_ARGS,
    href: "/money",
    run: async (scope) => (await import("@/modules/forecast")).getCashPlan(scope),
  },
  {
    name: "wip_report",
    description:
      "Work in progress across every open job: percent complete, earned revenue, and what is under- or over-billed.",
    requires: { departments: ["financials"] },
    mirrors: "src/app/api/wip/route.ts",
    schema: NO_ARGS,
    href: "/wip",
    run: async (scope) => (await import("@/modules/job-costing")).getWipReport(scope),
  },
  {
    name: "job_costing",
    description:
      "One job's money: contract, costs to date, committed purchase orders, WIP and the budget position.",
    requires: { departments: ["financials"] },
    mirrors: "src/app/api/jobs/[id]/costing/route.ts",
    schema: {
      type: "object",
      properties: { jobId: { type: "string", description: "The job's id (a uuid)." } },
      required: ["jobId"],
      additionalProperties: false,
    },
    href: "/wip",
    run: async (scope, args) =>
      (await import("@/modules/job-costing")).getJobCosting(scope, String(args.jobId)),
  },
  {
    name: "financial_statements",
    description:
      "Profit and loss, balance sheet and trial balance for a date range, straight from the ledger.",
    requires: { departments: ["financials"] },
    mirrors: "src/app/api/reports/statements/route.ts",
    schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date, YYYY-MM-DD." },
        to: { type: "string", description: "End date, YYYY-MM-DD." },
      },
      required: ["to"],
      additionalProperties: false,
    },
    href: "/reports",
    run: async (scope, args) =>
      (await import("@/modules/reporting")).getStatements(scope, {
        from: args.from ? String(args.from) : null,
        to: String(args.to),
      }),
  },
  {
    name: "owner_kpis",
    description:
      "The headline numbers: revenue this month, average invoice, close rate, and how long customers take to pay.",
    requires: { departments: ["financials"] },
    mirrors: "src/app/api/reports/forecast/route.ts",
    schema: NO_ARGS,
    href: "/money",
    run: async (scope) => (await import("@/modules/reporting")).getOwnerKpis(scope),
  },
  {
    name: "open_invoices",
    description: "Invoices that are issued or part-paid and still owed, oldest first.",
    requires: { departments: ["financials"] },
    mirrors: "src/app/api/reports/statements/route.ts",
    schema: NO_ARGS,
    href: "/money",
    // As of TODAY. The date is not a model argument: "what is owed" has one
    // sensible answer, and letting the model pick an as-of date is how an
    // aging report quietly becomes a different report.
    run: async (scope) =>
      (await import("@/modules/reporting")).getArAging(scope, new Date().toISOString().slice(0, 10)),
  },
  {
    name: "sales_tax",
    description: "Sales tax collected, what has been remitted, and what is still owed to the state.",
    requires: { departments: ["financials"] },
    mirrors: "src/app/api/tax/route.ts",
    schema: NO_ARGS,
    href: "/money",
    run: async (scope) => (await import("@/modules/sales-invoicing")).getSalesTaxSummary(scope),
  },
  {
    name: "job_profit",
    description:
      "What one job actually made: billed and collected against everything it cost, including hours nobody has posted yet.",
    /**
     * STRICTER than the route it mirrors, deliberately.
     *
     * /api/jobs/[id]/profit takes a bare requireScope() and then decides
     * between the full picture and a redacted crew view. This tool only ever
     * returns the FULL result, so it demands the wall that view requires.
     * "Mirrors" means never weaker — being stricter is always allowed, and
     * tools.test.ts checks it that way round.
     */
    requires: { departments: ["financials"] },
    mirrors: "src/app/api/jobs/[id]/profit/route.ts",
    schema: {
      type: "object",
      properties: { jobId: { type: "string", description: "The job's id (a uuid)." } },
      required: ["jobId"],
      additionalProperties: false,
    },
    href: "/jobs",
    run: async (scope, args) => {
      const jobId = String(args.jobId);
      const [{ getJobCosting, computeJobProfit }, { listPendingLaborByJob }] = await Promise.all([
        import("@/modules/job-costing"),
        import("@/modules/workforce"),
      ]);
      const costing = await getJobCosting(scope, jobId);
      // Burden must be computed per worker-WEEK and only then split by job —
      // see listPendingLaborByJob. Filtering to this job first would be wrong.
      const pending = await listPendingLaborByJob(scope);
      return computeJobProfit({
        contractCents: costing.contractCents,
        billedCents: costing.billedCents,
        collectedCents: costing.collectedCents,
        postedCostsCents: costing.costsCents,
        unpostedLaborCents: pending.find((x) => x.jobId === jobId)?.totalCents ?? 0,
      });
    },
  },
  {
    name: "job_list",
    description:
      "Open jobs with their numbers and names — use this to find a job's id before asking about one job.",
    // The ONLY tool outside the financials wall: a job list carries no money.
    // It exists so the model can resolve "the Henderson job" to an id without
    // being handed the whole book of business.
    requires: {},
    mirrors: "src/app/api/jobs/route.ts",
    schema: NO_ARGS,
    href: "/jobs",
    run: async (scope) => (await import("@/modules/field-ops")).listJobs(scope),
  },
];

/**
 * The tools THIS caller may use.
 *
 * Layer one of two. A member without the financials wall never sees that
 * `cash_plan` exists, so an injected instruction cannot name a tool that was
 * never offered — and `dispatch` re-checks anyway, because a list is a
 * convenience and the check is the control.
 */
export function toolsFor(scope: ResolvedScope): BooksTool[] {
  return TOOLS.filter((t) => holdsDepartments(scope, t.requires.departments ?? []));
}

export function toolByName(name: string): BooksTool | undefined {
  return TOOLS.find((t) => t.name === name);
}
