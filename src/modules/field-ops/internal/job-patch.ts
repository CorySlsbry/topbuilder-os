// The job-patch allowlist and its SET-clause builder. PURE — no I/O, no
// server-only marker — because the dangerous part of an edit route is which
// columns it will consent to write, and that deserves a test that runs in
// milliseconds without a database.

// `import type` is erased at compile time, so this pure module keeps ONE
// definition of JobType without taking on store.ts's server-only runtime.
import type { JobType } from "./store";

export interface JobPatch {
  name?: string;
  jobType?: JobType;
  budgetCents?: number;
  claimNumber?: string | null;
  carrier?: string | null;
  adjusterName?: string | null;
  adjusterPhone?: string | null;
  deductibleCents?: number | null;
  acvCents?: number | null;
  rcvCents?: number | null;
  depreciationInvoiced?: boolean;
  grossContractCents?: number | null;
  dealerFeeCents?: number | null;
  lender?: string | null;
  completedOn?: string | null;
}

/**
 * patch key -> column. **This map IS the allowlist.** A key absent from it
 * cannot be written no matter what a route lets through, which is why the
 * builder below looks the key up here rather than trusting its caller.
 *
 * ⛔ Deliberately absent, each for its own reason:
 *   contract_cents — migration 0043 installs a trigger requiring it to equal
 *     the SUM of contract_movements. The contract moves through estimate
 *     approval or a change order (a document with a number and an approver).
 *     Writing the cached total directly is the data-loss bug 0043 prevents.
 *   status      — its own route, its own transition rules.
 *   job_no      — identity; the number the crew says out loud.
 *   customer_id — moving a job to another customer is a different act.
 */
export const JOB_PATCH_COLUMNS: Record<keyof JobPatch, string> = {
  name: "name",
  jobType: "job_type",
  budgetCents: "budget_cents",
  claimNumber: "claim_number",
  carrier: "carrier",
  adjusterName: "adjuster_name",
  adjusterPhone: "adjuster_phone",
  deductibleCents: "deductible_cents",
  acvCents: "acv_cents",
  rcvCents: "rcv_cents",
  depreciationInvoiced: "depreciation_invoiced",
  grossContractCents: "gross_contract_cents",
  dealerFeeCents: "dealer_fee_cents",
  lender: "lender",
  completedOn: "completed_on",
};

/**
 * Build the SET fragments and their values for the keys actually present.
 *
 * ⛔ `undefined` means ABSENT; `null` means CLEAR IT. Those are different
 * requests — correcting a wrong claim number to empty is a real edit — and a
 * COALESCE-everything UPDATE cannot express the second. Likewise `false` and
 * `0` are values: a truthiness check here would silently swallow
 * `depreciationInvoiced: false`, which is exactly how a wrongly-fired nudge
 * gets put back.
 *
 * Parameters start at $2 because $1 is always the job id.
 */
export function buildJobPatchSql(patch: JobPatch): {
  sets: string[];
  values: (string | number | boolean | null)[];
} {
  const sets: string[] = [];
  const values: (string | number | boolean | null)[] = [];

  for (const key of Object.keys(patch) as (keyof JobPatch)[]) {
    const column = JOB_PATCH_COLUMNS[key];
    if (!column) continue; // not on the allowlist — never written
    const raw = patch[key];
    if (raw === undefined) continue; // absent, not cleared

    sets.push(`${column} = $${values.length + 2}`);
    values.push(typeof raw === "string" ? raw.trim() || null : raw);
  }

  return { sets, values };
}
