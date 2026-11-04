import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { listCostCodes as listTenantCostCodes } from "@/modules/job-costing";

/**
 * The category list behind the bank screen's picker.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * Categorizing used to mean typing `6210` into a text box. That is not a
 * category, it is a code, and the only person who can use it is one who has
 * already memorised a 478-row chart of accounts. Every shop coming off
 * QuickBooks expects to pick "Fuel and auto" from a list and move on.
 *
 * ── ORDERING IS MEASURED, NOT INVENTED ───────────────────────────────────
 * `uses` counts the tenant's OWN postings to each account in the last year,
 * so the categories a shop actually uses float to the top of the list. That
 * is the one bit of "smart" here and it is a COUNT(*) — no model, no
 * heuristic, nothing to be wrong about. A brand-new tenant simply gets every
 * count at zero and a plainly alphabetised chart, which is correct.
 *
 * ── THE DIRECTION FILTER IS A DEFAULT, NOT A WALL ────────────────────────
 * Money out usually lands in an expense or a cost account and money in lands
 * in revenue — but a refund from a supplier is money IN that belongs against
 * the expense it came from, and a bank fee is money OUT that is not a job
 * cost. So direction ranks the list; it never removes anything. Hiding the
 * account somebody actually needs is how a bookkeeper ends up coding
 * everything to "Ask my accountant".
 */

export interface Category {
  code: string;
  name: string;
  /** asset | liability | equity | revenue | cogs | expense | other */
  type: string;
  /** NAHB section label — the picker's optgroup. */
  section: string | null;
  /** How many times this tenant posted here in the last 365 days. */
  uses: number;
}

export interface CostCodeOption {
  code: string;
  name: string;
  /** The default cost kind, so picking a code fills the kind too. */
  kind: string;
}

/**
 * Every category a bank line can be coded to, most-used first within its
 * section. Equity is included on purpose: an owner contribution is a real
 * deposit, and "money the owner put in" has to have somewhere to go that is
 * not revenue.
 */
export async function listCategories(scope: TenantScope): Promise<Category[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      code: string;
      name: string;
      type: string;
      section: string | null;
      uses: string;
    }>(
      // The usage count is bounded to a year and joined through
      // journal_entries rather than counting the whole journal: on a shop
      // with five years of history the unbounded version reads every line
      // ever posted to fill in a dropdown.
      `SELECT a.code, a.name, a.type, a.section,
              COALESCE(u.n, 0) AS uses
         FROM chart_of_accounts a
         LEFT JOIN (
           SELECT l.account_id, COUNT(*) AS n
             FROM journal_lines l
             JOIN journal_entries e ON e.id = l.entry_id
            WHERE e.occurred_on >= CURRENT_DATE - 365
            GROUP BY l.account_id
         ) u ON u.account_id = a.id
        WHERE a.is_active
        ORDER BY a.section NULLS LAST, COALESCE(u.n, 0) DESC, a.code`,
    );
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      type: r.type,
      section: r.section,
      uses: Number(r.uses),
    }));
  });
}

/**
 * Cost codes for the job-cost path.
 *
 * A job cost needs a SECOND answer beyond the job — what kind of work it was
 * — and until now the screen answered it for you with a hardcoded `4100`, on
 * every line, forever. That made cost-code reporting a formality: every cost
 * in the shop landed in one bucket and the by-code breakdown on the job
 * screen said nothing.
 *
 * ⛔ NO FALLBACK TO THE CHART OF ACCOUNTS. The first version of this fell
 * back to the chart's cost and COGS accounts so the dropdown was never
 * empty. Opening it in a browser showed what that actually meant for an HVAC
 * shop: the list led with "Accumulated allocations, land and land
 * development costs". It worked, it was honest, and it was the wrong
 * vocabulary — which is a worse failure than an empty list, because an empty
 * list sends someone to set their codes up and a wrong list gets used.
 *
 * Empty now means empty, and the screen says "set up your cost codes" with a
 * link. One source of truth: the `job-costing` module owns this table.
 */
export async function listCostCodes(scope: TenantScope): Promise<CostCodeOption[]> {
  const rows = await listTenantCostCodes(scope);
  return rows.map((r) => ({ code: r.code, name: r.name, kind: r.kind }));
}
