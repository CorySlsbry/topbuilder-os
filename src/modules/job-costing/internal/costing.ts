import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { computeWip, explainWip, explainWipPortfolio, type WipResult } from "./money/wip";
import { computeCommitted, explainCommitted, type CommittedResult } from "./money/committed";

export class CostingError extends HttpError {
  constructor(status: 404 | 422, code: string) {
    super(status, code);
  }
}

/**
 * WIP inputs, straight from the books (never cached, never hand-entered):
 *   costs to date  = Σ cost_entries for the job
 *   billed to date = Σ invoice subtotals, PRE-TAX, voids excluded (sales tax
 *                    is a pass-through liability — it is not billings)
 *   committed      = Σ open POs + open sub commitments
 *   contract / ETC = the job row (ETC is the owner's input via setEtc)
 */
interface JobFacts {
  job: {
    id: string;
    name: string;
    job_no: number;
    contract_cents: string;
    budget_cents: string;
    est_cost_to_complete_cents: string | null;
    etc_updated_at: string | null;
    status: string;
  };
  costsCents: number;
  billedCents: number;
  /** Money actually received against this job's invoices. Billed is a claim;
   *  collected is a fact, and the two answer different questions. */
  collectedCents: number;
  committedPoCents: number;
  committedSubCents: number;
  costsByCode: { costCode: string; kind: string; amountCents: number }[];
}

/**
 * Load the facts for MANY jobs in a fixed number of queries.
 *
 * ⛔ This replaces a per-job loader that issued 5 sequential queries and was
 * called in a loop by getWipReport. Forty open jobs was 201 sequential round
 * trips in a single request — the slowest thing in the application, sitting
 * behind the financials wall on a screen an owner opens every morning. It also
 * feeds the cash plan and the books-QA tool, both of which have a latency
 * budget measured in one page load.
 *
 * Passing null for the ids means "every job that is not closed" — the WIP
 * portfolio.
 *
 * Only the FETCH shape changes. buildCosting is pure and was already separate,
 * so every figure still comes from the same money modules and the existing TDD
 * suite still guards the arithmetic byte for byte.
 */
async function loadJobFactsBatch(
  c: PoolClient,
  jobIds: string[] | null,
): Promise<Map<string, JobFacts>> {
  const filter = jobIds ? "WHERE id = ANY($1)" : "WHERE status <> 'closed'";
  const params = jobIds ? [jobIds] : [];

  const jobs = await c.query(
    `SELECT id, name, job_no, contract_cents, budget_cents,
            est_cost_to_complete_cents, etc_updated_at, status
       FROM jobs ${filter} ORDER BY job_no`,
    params,
  );
  const facts = new Map<string, JobFacts>();
  for (const job of jobs.rows) {
    facts.set(job.id, {
      job: job as never,
      costsCents: 0,
      billedCents: 0,
      collectedCents: 0,
      committedPoCents: 0,
      committedSubCents: 0,
      costsByCode: [],
    });
  }
  if (facts.size === 0) return facts;
  const ids = [...facts.keys()];

  const costs = await c.query<{ job_id: string; total: string }>(
    `SELECT job_id, COALESCE(SUM(amount_cents),0) AS total
       FROM cost_entries WHERE job_id = ANY($1) GROUP BY job_id`,
    [ids],
  );
  for (const r of costs.rows) facts.get(r.job_id)!.costsCents = Number(r.total);

  // PRE-TAX, voids excluded: sales tax is a pass-through liability, not
  // billings, and it must never reach a margin. NET of the member discount
  // too — `subtotal_cents` is the gross list price, and billing a member
  // 15% off does not put the list price in the bank.
  const billed = await c.query<{ job_id: string; total: string }>(
    `SELECT job_id, COALESCE(SUM(net_subtotal_cents),0) AS total
       FROM invoices WHERE job_id = ANY($1) AND status <> 'void' GROUP BY job_id`,
    [ids],
  );
  for (const r of billed.rows) facts.get(r.job_id)!.billedCents = Number(r.total);

  const collected = await c.query<{ job_id: string; total: string }>(
    `SELECT i.job_id, COALESCE(SUM(p.amount_cents),0) AS total
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE i.job_id = ANY($1) AND i.status <> 'void' GROUP BY i.job_id`,
    [ids],
  );
  for (const r of collected.rows) facts.get(r.job_id)!.collectedCents = Number(r.total);

  const committed = await c.query<{ job_id: string; kind: string; total: string }>(
    `SELECT job_id, kind, COALESCE(SUM(amount_cents),0) AS total
       FROM purchase_orders WHERE job_id = ANY($1) AND status = 'open'
      GROUP BY job_id, kind`,
    [ids],
  );
  for (const r of committed.rows) {
    const f = facts.get(r.job_id)!;
    if (r.kind === "po") f.committedPoCents = Number(r.total);
    if (r.kind === "sub") f.committedSubCents = Number(r.total);
  }

  const byCode = await c.query<{
    job_id: string;
    costCode: string;
    kind: string;
    amountCents: string;
  }>(
    `SELECT job_id, cost_code AS "costCode", kind, SUM(amount_cents) AS "amountCents"
       FROM cost_entries WHERE job_id = ANY($1)
      GROUP BY job_id, cost_code, kind ORDER BY SUM(amount_cents) DESC`,
    [ids],
  );
  for (const r of byCode.rows) {
    facts.get(r.job_id)!.costsByCode.push({
      costCode: r.costCode,
      kind: r.kind,
      amountCents: Number(r.amountCents),
    });
  }

  return facts;
}

/** One job. Calls the batch with a single id so there is ONE fetch shape to
 *  reason about, and no second implementation to drift from it. */
async function loadJobFacts(c: PoolClient, jobId: string): Promise<JobFacts> {
  const facts = await loadJobFactsBatch(c, [jobId]);
  const f = facts.get(jobId);
  if (!f) throw new CostingError(404, "job_not_found");
  return f;
}

export interface JobCosting {
  jobId: string;
  jobNo: number;
  name: string;
  status: string;
  contractCents: number;
  budgetCents: number;
  costsCents: number; // Σ cost_entries to date
  etcCents: number | null; // null = the owner has never set it
  wip: WipResult;
  committed: CommittedResult;
  billedCents: number;
  /** Σ payments received against this job's invoices. Billed is a claim;
   *  collected is a fact, and job profit is stated both ways. */
  collectedCents: number;
  costsByCode: { costCode: string; kind: string; amountCents: number }[];
  /** Plain-language explainers (deterministic templates, figures verbatim). */
  explain: { wip: string; committed: string };
}

function buildCosting(
  facts: Awaited<ReturnType<typeof loadJobFacts>>,
): JobCosting {
  const contract = Number(facts.job.contract_cents);
  const budget = Number(facts.job.budget_cents);
  const etcRaw = facts.job.est_cost_to_complete_cents;
  const etc = etcRaw === null ? null : Number(etcRaw);
  const etcAgeDays = facts.job.etc_updated_at
    ? Math.floor((Date.now() - new Date(facts.job.etc_updated_at).getTime()) / 86_400_000)
    : undefined;

  const wip = computeWip({
    contractCents: contract,
    costsToDateCents: facts.costsCents,
    // No ETC yet → treat remaining budget as the estimate (flagged via null etc).
    estCostToCompleteCents: etc ?? Math.max(0, budget - facts.costsCents),
    billedToDateCents: facts.billedCents,
    etcAgeDays,
  });
  const committed = computeCommitted({
    budgetCents: budget,
    actualCents: facts.costsCents,
    openPoCents: facts.committedPoCents,
    expectedSubCents: facts.committedSubCents,
  });
  return {
    jobId: facts.job.id,
    jobNo: Number(facts.job.job_no),
    name: facts.job.name,
    status: facts.job.status,
    contractCents: contract,
    budgetCents: budget,
    costsCents: facts.costsCents,
    etcCents: etc,
    wip,
    committed,
    billedCents: facts.billedCents,
    collectedCents: facts.collectedCents,
    costsByCode: facts.costsByCode,
    explain: { wip: explainWip(wip), committed: explainCommitted(committed) },
  };
}

export async function getJobCosting(
  scope: TenantScope,
  jobId: string,
): Promise<JobCosting> {
  return withTenant(scope, async (c) => buildCosting(await loadJobFacts(c, jobId)));
}

/** The owner's estimate-to-complete — the one WIP input only they can supply. */
export async function setEtc(
  scope: TenantScope,
  jobId: string,
  etcCents: number,
): Promise<void> {
  if (!Number.isSafeInteger(etcCents) || etcCents < 0) {
    throw new CostingError(422, "etc_must_be_nonnegative");
  }
  await withTenant(scope, async (c) => {
    const res = await c.query(
      `UPDATE jobs SET est_cost_to_complete_cents = $2, etc_updated_at = now()
       WHERE id = $1`,
      [jobId, etcCents],
    );
    if (res.rowCount === 0) throw new CostingError(404, "job_not_found");
  });
}

// ------------------------------------------------- purchase orders (lean)
export interface PurchaseOrderRow {
  id: string;
  kind: "po" | "sub";
  vendorName: string;
  description: string;
  amountCents: number;
  status: "open" | "received" | "canceled";
}

export async function addPurchaseOrder(
  scope: TenantScope,
  input: {
    jobId: string;
    kind: "po" | "sub";
    vendorName: string;
    description?: string;
    amountCents: number;
  },
): Promise<string> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new CostingError(422, "po_amount_must_be_positive");
  }
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO purchase_orders
         (tenant_id, job_id, kind, vendor_name, description, amount_cents, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        scope.tenantId, input.jobId, input.kind, input.vendorName,
        input.description ?? "", input.amountCents, scope.uid,
      ],
    );
    return rows[0]!.id;
  });
}

export async function listPurchaseOrders(
  scope: TenantScope,
  jobId: string,
): Promise<PurchaseOrderRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<PurchaseOrderRow>(
      `SELECT id, kind, vendor_name AS "vendorName", description,
              amount_cents AS "amountCents", status
         FROM purchase_orders WHERE job_id = $1 ORDER BY created_at DESC`,
      [jobId],
    );
    return rows.map((r) => ({ ...r, amountCents: Number(r.amountCents) }));
  });
}

/**
 * Status transitions only (open → received/canceled). Receiving a PO does NOT
 * post the cost automatically in this slice — the bill/receipt is captured as
 * a cost entry (S4 flow) which is what actually hits the books; the PO simply
 * stops counting as committed. S12 (purchasing/AP) wires receiving → bill.
 */
export async function setPurchaseOrderStatus(
  scope: TenantScope,
  poId: string,
  status: "received" | "canceled",
): Promise<void> {
  await withTenant(scope, async (c) => {
    const res = await c.query(
      "UPDATE purchase_orders SET status = $2 WHERE id = $1 AND status = 'open'",
      [poId, status],
    );
    if (res.rowCount === 0) throw new CostingError(404, "open_po_not_found");
  });
}

// ------------------------------------------------- WIP snapshots + report
export interface WipReportRow extends JobCosting {
  asOf?: string;
}

/** Portfolio WIP: every non-closed job. Σ under / Σ over are NEVER netted. */
export async function getWipReport(scope: TenantScope): Promise<{
  rows: JobCosting[];
  totals: {
    underbilledCents: number;
    overbilledCents: number;
    contractCents: number;
    costsCents: number;
    earnedCents: number;
    billedCents: number;
  };
  /** The totals row in plain English — the part an owner reads first. */
  explain: string;
}> {
  return withTenant(scope, async (c) => {
    // One batch, five queries — not five per job. buildCosting stays pure, so
    // every figure still comes from the same money modules.
    const facts = await loadJobFactsBatch(c, null);
    const rows: JobCosting[] = [...facts.values()].map(buildCosting);
    const totals = rows.reduce(
      (t, r) => ({
        underbilledCents: t.underbilledCents + r.wip.underbilledCents,
        overbilledCents: t.overbilledCents + r.wip.overbilledCents,
        contractCents: t.contractCents + r.contractCents,
        costsCents: t.costsCents + r.costsCents,
        earnedCents: t.earnedCents + r.wip.earnedRevenueCents,
        billedCents: t.billedCents + r.billedCents,
      }),
      { underbilledCents: 0, overbilledCents: 0, contractCents: 0, costsCents: 0, earnedCents: 0, billedCents: 0 },
    );
    return { rows, totals, explain: explainWipPortfolio(totals) };
  });
}

/** Freeze today's WIP math for a job into the immutable snapshot table. */
export async function takeWipSnapshot(
  scope: TenantScope,
  jobId: string,
  asOf: string,
): Promise<string> {
  return withTenant(scope, async (c) => {
    const facts = await loadJobFacts(c, jobId);
    const costing = buildCosting(facts);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO wip_snapshots (tenant_id, job_id, as_of, contract_cents,
         costs_to_date_cents, etc_cents, committed_cents, pct_complete_bps,
         earned_cents, billed_cents, underbilled_cents, overbilled_cents, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        scope.tenantId, jobId, asOf, costing.contractCents, facts.costsCents,
        costing.etcCents ?? Math.max(0, costing.budgetCents - facts.costsCents),
        costing.committed.committedCents, costing.wip.pctCompleteBps,
        costing.wip.earnedRevenueCents, costing.billedCents,
        costing.wip.underbilledCents, costing.wip.overbilledCents, scope.uid,
      ],
    );
    return rows[0]!.id;
  });
}
