import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { buildJobPatchSql, type JobPatch } from "./job-patch";
export type { JobPatch } from "./job-patch";
import { postJournalEntryTx } from "@/modules/ledger";
import { postCostCaptured, type PostingAccounts } from "@/modules/job-costing";
import { HttpError } from "@/lib/http/errors";

export class FieldOpsError extends HttpError {
  constructor(status: 404 | 422, code: string) {
    super(status, code);
  }
}

/**
 * Default GL mapping onto the seeded NAHB chart — every code verified to
 * exist in db/seed/nahb-coa.csv. Becomes tenant-configurable in S5; the
 * codes here are the sane defaults the doctrine demands.
 *   1020 Cash, general · 1210 Accounts receivable · 1290 Retainage receivable
 *   3100 Sales (revenue) · 2350 Sales and use taxes payable
 *   2010 Contract deposits · 5090 Interest expense, other (dealer/financing fees)
 *   1430 Direct construction cost (job cost) · 2110 Accounts payable, trade
 */
export const DEFAULT_POSTING_ACCOUNTS: PostingAccounts = {
  cash: "1020",
  ar: "1210",
  retainageReceivable: "1290",
  revenue: "3100",
  taxPayable: "2350",
  customerDeposits: "2010",
  dealerFeeCost: "5090",
  jobCost: "1430",
  ap: "2110",
};

/** Personal-expense destinations on the NAHB chart (see job-costing/personal). */
export const DEFAULT_OWNER_ACCOUNTS = {
  /** 2960 Distributions, dividends, and draws (equity). */
  drawsAccountCode: "2960",
  /** 1660 Due from officers, stockholders, owners, or partners (asset). */
  dueFromOwnerAccountCode: "1660",
} as const;

export type JobType = "retail" | "insurance-restoration" | "solar-financed";
export type JobStatus = "lead" | "scheduled" | "in-progress" | "complete" | "closed";

export interface NewCustomer {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
}

export async function createCustomer(
  scope: TenantScope,
  input: NewCustomer,
): Promise<string> {
  if (!input.name.trim()) throw new FieldOpsError(422, "customer_name_required");
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email, phone, address)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [scope.tenantId, input.name.trim(), input.email ?? null, input.phone ?? null, input.address ?? null],
    );
    return rows[0]!.id;
  });
}

export interface NewJob {
  customerId: string;
  name: string;
  jobType?: JobType;
  contractCents?: number;
  budgetCents?: number;
  // insurance-restoration
  claimNumber?: string;
  carrier?: string;
  adjusterName?: string;
  adjusterPhone?: string;
  deductibleCents?: number;
  acvCents?: number;
  rcvCents?: number;
  // solar-financed
  grossContractCents?: number;
  dealerFeeCents?: number;
  lender?: string;
}

export async function createJob(
  scope: TenantScope,
  input: NewJob,
): Promise<{ id: string; jobNo: number }> {
  if (!input.name.trim()) throw new FieldOpsError(422, "job_name_required");
  return withTenant(scope, async (c) => {
    const counter = await c.query<{ value: string }>(
      "SELECT app.next_counter('job_no') AS value",
    );
    const jobNo = Number(counter.rows[0]!.value);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO jobs (tenant_id, customer_id, job_no, name, job_type,
                         contract_cents, budget_cents, claim_number, carrier,
                         adjuster_name, adjuster_phone,
                         deductible_cents, acv_cents, rcv_cents,
                         gross_contract_cents, dealer_fee_cents, lender)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        scope.tenantId, input.customerId, jobNo, input.name.trim(),
        input.jobType ?? "retail", input.contractCents ?? 0, input.budgetCents ?? 0,
        input.claimNumber ?? null, input.carrier ?? null,
        input.adjusterName ?? null, input.adjusterPhone ?? null,
        input.deductibleCents ?? null, input.acvCents ?? null, input.rcvCents ?? null,
        input.grossContractCents ?? null, input.dealerFeeCents ?? null, input.lender ?? null,
      ],
    );
    return { id: rows[0]!.id, jobNo };
  });
}

export async function scheduleAppointment(
  scope: TenantScope,
  input: { jobId: string; startsAt: string; endsAt: string; assigneeUid?: string; notes?: string },
): Promise<string> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO appointments (tenant_id, job_id, starts_at, ends_at, assignee_uid, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [scope.tenantId, input.jobId, input.startsAt, input.endsAt, input.assigneeUid ?? null, input.notes ?? null],
    );
    // A lead with its first appointment becomes 'scheduled' (the LIR event).
    await c.query(
      `UPDATE jobs SET status = 'scheduled' WHERE id = $1 AND status = 'lead'`,
      [input.jobId],
    );
    await c.query(
      `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid)
       VALUES ($1, 'job_scheduled', 'job', $2, $3)`,
      [scope.tenantId, input.jobId, scope.uid],
    );
    return rows[0]!.id;
  });
}

export interface CaptureCostInput {
  jobId: string;
  costCode: string;
  kind: "labor" | "material" | "sub" | "equipment" | "other";
  amountCents: number;
  occurredOn: string; // yyyy-mm-dd
  memo?: string;
  paidFrom: "cash" | "ap";
  /** Tenant COA mapping for the GL posting. */
  accounts: PostingAccounts;
}

/**
 * Capture a field cost: the append-only cost_entry AND its balanced GL
 * posting commit in ONE transaction — the operational ledger and the book of
 * record can never disagree.
 */
export async function captureCost(
  scope: TenantScope,
  input: CaptureCostInput,
): Promise<{ costEntryId: string; journalEntryId: string }> {
  return withTenant(scope, async (c) => {
    const entry = postCostCaptured({
      occurredOn: input.occurredOn,
      accounts: input.accounts,
      amountCents: input.amountCents,
      paidFrom: input.paidFrom,
      dims: { jobId: input.jobId, costCode: input.costCode },
    });
    const journalEntryId = await postJournalEntryTx(c, scope, entry);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO cost_entries (tenant_id, job_id, cost_code, kind, amount_cents,
                                 memo, source_type, journal_entry_id, occurred_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$8,$9) RETURNING id`,
      [
        scope.tenantId, input.jobId, input.costCode, input.kind, input.amountCents,
        input.memo ?? "", journalEntryId, input.occurredOn, scope.uid,
      ],
    );
    await c.query(
      `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid)
       VALUES ($1, 'cost_captured', 'job', $2, $3)`,
      [scope.tenantId, input.jobId, scope.uid],
    );
    return { costEntryId: rows[0]!.id, journalEntryId };
  });
}

export interface JobScreen {
  job: Record<string, unknown>;
  costTotalCents: number;
  appointmentCount: number;
  depreciationNudge: boolean;
}

/**
 * Just the customer a job belongs to.
 *
 * A one-column read rather than getJobScreen, because the caller that needs
 * it (the invoice route, looking up the member discount) would otherwise pull
 * the whole job screen — costs, appointment counts, the depreciation nudge —
 * to learn one uuid.
 */
export async function getJobCustomerId(
  scope: TenantScope,
  jobId: string,
): Promise<string | null> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ customer_id: string }>(
      "SELECT customer_id FROM jobs WHERE id = $1",
      [jobId],
    );
    return rows[0]?.customer_id ?? null;
  });
}

/** One-screen-per-job: everything the owner needs about a job in one query set. */
export async function getJobScreen(
  scope: TenantScope,
  jobId: string,
): Promise<JobScreen> {
  return withTenant(scope, async (c) => {
    const job = await c.query("SELECT * FROM jobs WHERE id = $1", [jobId]);
    if (job.rowCount === 0) throw new FieldOpsError(404, "job_not_found");
    const costs = await c.query<{ total: string }>(
      "SELECT COALESCE(SUM(amount_cents),0) AS total FROM cost_entries WHERE job_id = $1",
      [jobId],
    );
    const appts = await c.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM appointments WHERE job_id = $1",
      [jobId],
    );
    const nudge = await c.query(
      "SELECT 1 FROM pending_depreciation_nudges WHERE job_id = $1",
      [jobId],
    );
    return {
      job: job.rows[0] as Record<string, unknown>,
      costTotalCents: Number(costs.rows[0]!.total),
      appointmentCount: Number(appts.rows[0]!.n),
      depreciationNudge: (nudge.rowCount ?? 0) > 0,
    };
  });
}

export async function setJobStatus(
  scope: TenantScope,
  jobId: string,
  status: JobStatus,
  completedOn?: string,
): Promise<void> {
  await withTenant(scope, async (c) => {
    const res = await c.query(
      `UPDATE jobs SET status = $2, completed_on = COALESCE($3, completed_on)
       WHERE id = $1`,
      [jobId, status, completedOn ?? null],
    );
    if (res.rowCount === 0) throw new FieldOpsError(404, "job_not_found");
  });
}

export interface JobListRow {
  id: string;
  jobNo: number;
  name: string;
  jobType: JobType;
  status: JobStatus;
  customerName: string;
  costTotalCents: number;
}

export async function listJobs(scope: TenantScope): Promise<JobListRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<JobListRow>(
      `SELECT j.id, j.job_no AS "jobNo", j.name, j.job_type AS "jobType",
              j.status, cu.name AS "customerName",
              COALESCE((SELECT SUM(ce.amount_cents) FROM cost_entries ce
                         WHERE ce.job_id = j.id), 0)::bigint AS "costTotalCents"
         FROM jobs j JOIN customers cu ON cu.id = j.customer_id
        ORDER BY j.job_no DESC`,
    );
    return rows.map((r) => ({ ...r, costTotalCents: Number(r.costTotalCents) }));
  });
}

// ------------------------------------------------- attachments (receipts)
export interface AttachmentMeta {
  id: string;
  jobId: string;
  kind: "receipt" | "photo" | "document";
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  originalName: string | null;
  createdAt: string;
}

export async function addAttachment(
  scope: TenantScope,
  input: {
    jobId: string;
    kind: "receipt" | "photo" | "document";
    storageKey: string;
    contentType: string;
    sizeBytes: number;
    originalName?: string;
    costEntryId?: string;
  },
): Promise<string> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO job_attachments
         (tenant_id, job_id, cost_entry_id, kind, storage_key, content_type,
          size_bytes, original_name, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        scope.tenantId, input.jobId, input.costEntryId ?? null, input.kind,
        input.storageKey, input.contentType, input.sizeBytes,
        input.originalName ?? null, scope.uid,
      ],
    );
    return rows[0]!.id;
  });
}

export async function listAttachments(
  scope: TenantScope,
  jobId: string,
): Promise<AttachmentMeta[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<AttachmentMeta>(
      `SELECT id, job_id AS "jobId", kind, storage_key AS "storageKey",
              content_type AS "contentType", size_bytes AS "sizeBytes",
              original_name AS "originalName", created_at AS "createdAt"
         FROM job_attachments WHERE job_id = $1 ORDER BY created_at DESC`,
      [jobId],
    );
    return rows.map((r) => ({ ...r, sizeBytes: Number(r.sizeBytes) }));
  });
}

export async function getAttachment(
  scope: TenantScope,
  attachmentId: string,
): Promise<AttachmentMeta | null> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<AttachmentMeta>(
      `SELECT id, job_id AS "jobId", kind, storage_key AS "storageKey",
              content_type AS "contentType", size_bytes AS "sizeBytes",
              original_name AS "originalName", created_at AS "createdAt"
         FROM job_attachments WHERE id = $1`,
      [attachmentId],
    );
    return rows[0] ?? null;
  });
}

// ------------------------------------------------- onboarding wiring
export interface TaxProfileInput {
  state: string;
  method: "none" | "retail" | "gross-factor" | "materials-cost";
  stateBps?: number;
  countyBps?: number;
  cityBps?: number;
  factorBps?: number;
  source?: string;
}

export async function upsertTaxProfile(
  scope: TenantScope,
  p: TaxProfileInput,
): Promise<void> {
  await withTenant(scope, async (c) => {
    await c.query(
      `INSERT INTO tenant_tax_profiles
         (tenant_id, state, method, state_bps, county_bps, city_bps, factor_bps, source, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         state = EXCLUDED.state, method = EXCLUDED.method,
         state_bps = EXCLUDED.state_bps, county_bps = EXCLUDED.county_bps,
         city_bps = EXCLUDED.city_bps, factor_bps = EXCLUDED.factor_bps,
         source = EXCLUDED.source, updated_at = now()`,
      [
        scope.tenantId, p.state.toUpperCase(), p.method,
        p.stateBps ?? 0, p.countyBps ?? 0, p.cityBps ?? 0,
        p.factorBps ?? null, p.source ?? "manual",
      ],
    );
  });
}

/**
 * Edit a job after it was booked.
 *
 * ⛔ WHY THIS EXISTS: until now `/api/jobs/[id]` had only a GET, so nothing
 * about a job could be corrected once created. That is wrong for every job and
 * fatal for one kind — on an insurance restoration the claim number, the
 * adjuster and above all the **RCV** are settled AFTER the work is booked, and
 * `pending_depreciation_nudges` needs `rcv_cents` to fire. The product's own
 * "if you do not invoice the depreciation you do not get it" feature was
 * therefore inert: its screen was finished (`getJobSummary` reads the view,
 * the job page renders it) but no code path could supply the input, and
 * `depreciation_invoiced` had ZERO writers anywhere, so a nudge that did fire
 * could never be dismissed. Three columns — `adjuster_name`, `adjuster_phone`,
 * `deductible_cents` — were unreachable from any caller at all.
 *
 * ⛔ WHAT IS DELIBERATELY NOT HERE, each for its own reason:
 *   contract_cents — migration 0043 installs a trigger requiring it to equal
 *     the SUM of contract_movements. A contract changes through estimate
 *     approval or a change order, which are documents with a number and an
 *     approver. Patching the cached total directly is exactly the data-loss
 *     bug 0043 exists to prevent.
 *   status        — has its own route and its own transition rules.
 *   job_no        — the number the crew says out loud; it is identity.
 *   customer_id   — moving a job to a different customer is a different act
 *                   with different consequences, not an edit of this one.
 *
 * Partial by construction: only the keys PRESENT in `patch` reach the SET
 * clause, so "field absent" and "field explicitly cleared to null" stay
 * different requests. A COALESCE-everything update cannot express the second.
 */
export async function updateJob(
  scope: TenantScope,
  jobId: string,
  patch: JobPatch,
): Promise<void> {
  if (patch.name !== undefined && !patch.name.trim()) {
    throw new FieldOpsError(422, "job_name_required");
  }
  // The allowlist and the $n numbering live in job-patch.ts, pure and tested.
  const { sets, values } = buildJobPatchSql(patch);
  if (sets.length === 0) throw new FieldOpsError(422, "nothing_to_update");

  await withTenant(scope, async (c) => {
    const res = await c.query(
      `UPDATE jobs SET ${sets.join(", ")} WHERE id = $1`,
      [jobId, ...values],
    );
    // RLS makes another tenant's job simply invisible, so "no rows" is the
    // same answer for "does not exist" and "not yours" — which is the answer
    // we want to give either way.
    if (res.rowCount === 0) throw new FieldOpsError(404, "job_not_found");
  });
}
