// Who may see what a job made — the per-tenant decision, read and written.
//
// The narrowing itself is `crewProfitView` (pure, in money/job-profit.ts) and
// the wall is applied in the route. This file only stores and returns the
// shop's answer.

import { withTenant, type TenantScope } from "@/lib/db/tenant";

export interface JobVisibility {
  crewSeesProfit: boolean;
  updatedBy: string;
  updatedAt: string | null;
}

/**
 * The shop's setting, with the safe answer as the default.
 *
 * A tenant that has never opened the settings screen has NO ROW, and the
 * absence must resolve to `false` — not to a null the caller then has to
 * remember to treat as off. This is the read that stands between a crew
 * member and a payroll disclosure by subtraction, so the missing case is
 * written out explicitly rather than left to a truthiness check.
 */
export async function getJobVisibility(scope: TenantScope): Promise<JobVisibility> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      crew_sees_profit: boolean;
      updated_by: string;
      updated_at: string;
    }>(
      `SELECT crew_sees_profit, updated_by, updated_at::text
         FROM job_visibility_settings WHERE tenant_id = $1`,
      [scope.tenantId],
    );
    const row = rows[0];
    if (!row) return { crewSeesProfit: false, updatedBy: "", updatedAt: null };
    return {
      crewSeesProfit: row.crew_sees_profit,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  });
}

/** Change it. The route requires owner/admin AND a second factor. */
export async function setJobVisibility(
  scope: TenantScope,
  crewSeesProfit: boolean,
): Promise<JobVisibility> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      crew_sees_profit: boolean;
      updated_by: string;
      updated_at: string;
    }>(
      `INSERT INTO job_visibility_settings (tenant_id, crew_sees_profit, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id) DO UPDATE
         SET crew_sees_profit = EXCLUDED.crew_sees_profit,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
       RETURNING crew_sees_profit, updated_by, updated_at::text`,
      [scope.tenantId, crewSeesProfit, scope.uid],
    );
    // ⛔ A zero-row RETURNING here would mean the policy admitted the INSERT
    // but not the UPDATE branch, and the caller would get a 200 for a write
    // that never happened. Migration 0042 shipped exactly that bug.
    const row = rows[0];
    if (!row) throw new Error("job_visibility_write_matched_no_rows");
    return {
      crewSeesProfit: row.crew_sees_profit,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  });
}
