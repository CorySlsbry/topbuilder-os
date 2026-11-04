import "server-only";
import { getPool } from "@/lib/db/pool";

// LIR cohort chart data. Cross-tenant aggregates come from the
// SECURITY DEFINER function app.lir_cohorts() (migration 0010), which
// returns ONLY anonymous per-cohort counts. Callers must be gated by the
// platform-operator allowlist — see isPlatformOperator.

export interface LirCohort {
  cohortMonth: string;
  tenants: number;
  tenantsThroughLoop: number;
  loopJobs: number;
  /** tenantsThroughLoop / tenants, in basis points. Target: 7000 (70%). */
  rateBps: number;
}

export const LIR_TARGET_BPS = 7000;

export function isPlatformOperator(uid: string): boolean {
  const allow = (process.env.PLATFORM_OPERATOR_UIDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.includes(uid);
}

export async function getLirCohorts(): Promise<LirCohort[]> {
  const { rows } = await getPool().query<{
    cohort_month: string;
    tenants: string;
    tenants_through_loop: string;
    loop_jobs: string;
  }>("SELECT * FROM app.lir_cohorts()");
  return rows.map((r) => {
    const tenants = Number(r.tenants);
    const through = Number(r.tenants_through_loop);
    return {
      cohortMonth: r.cohort_month,
      tenants,
      tenantsThroughLoop: through,
      loopJobs: Number(r.loop_jobs),
      rateBps: tenants === 0 ? 0 : Math.round((through * 10000) / tenants),
    };
  });
}
