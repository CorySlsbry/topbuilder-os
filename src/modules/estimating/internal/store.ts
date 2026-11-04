import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { mulDivHalfUp } from "@/lib/money/cents";
import { HttpError } from "@/lib/http/errors";

export class EstimateError extends HttpError {
  constructor(status: 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

export interface PricebookItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  unit: string;
  unitPriceCents: number;
  trade: string | null;
  category: string;
  hasPhoto: boolean;
}

export async function listPricebook(scope: TenantScope): Promise<PricebookItem[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<PricebookItem>(
      `SELECT id, code, name, description, unit,
              unit_price_cents AS "unitPriceCents", trade, category,
              (photo_key IS NOT NULL) AS "hasPhoto"
         FROM pricebook_items WHERE is_active ORDER BY category, code`,
    );
    return rows.map((r) => ({ ...r, unitPriceCents: Number(r.unitPriceCents) }));
  });
}

export async function addPricebookItem(
  scope: TenantScope,
  item: {
    code: string;
    name: string;
    description?: string;
    unit?: string;
    unitPriceCents: number;
    unitCostCents?: number;
    trade?: string;
    category?: string;
  },
): Promise<string> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO pricebook_items
         (tenant_id, code, name, description, unit, unit_price_cents, unit_cost_cents, trade, category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, code) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         unit_price_cents = EXCLUDED.unit_price_cents,
         category = EXCLUDED.category
       RETURNING id`,
      [
        scope.tenantId, item.code, item.name, item.description ?? null,
        item.unit ?? "each", item.unitPriceCents, item.unitCostCents ?? null,
        item.trade ?? null, item.category ?? "",
      ],
    );
    return rows[0]!.id;
  });
}

/** Attach the menu photo (storage key generated server-side, never caller paths). */
export async function setPricebookPhoto(
  scope: TenantScope,
  itemId: string,
  photoKey: string,
  photoType: string,
): Promise<void> {
  await withTenant(scope, async (c) => {
    const r = await c.query(
      `UPDATE pricebook_items SET photo_key = $2, photo_type = $3 WHERE id = $1`,
      [itemId, photoKey, photoType],
    );
    if (r.rowCount === 0) throw new EstimateError(404, "item_not_found");
  });
}

export async function getPricebookPhoto(
  scope: TenantScope,
  itemId: string,
): Promise<{ photoKey: string; photoType: string } | null> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ photo_key: string | null; photo_type: string | null }>(
      `SELECT photo_key, photo_type FROM pricebook_items WHERE id = $1`,
      [itemId],
    );
    const r = rows[0];
    if (!r?.photo_key || !r.photo_type) return null;
    return { photoKey: r.photo_key, photoType: r.photo_type };
  });
}

export interface EstimateOptionInput {
  tier: "good" | "better" | "best";
  title: string;
  summary?: string;
  lines: {
    description: string;
    qtyX100: number; // 2.5 units → 250
    unitPriceCents: number;
    pricebookItemId?: string;
  }[];
}

/** Line total = qty × unit price, half-up — the same rounding law as the GL. */
export function lineTotalCents(qtyX100: number, unitPriceCents: number): number {
  if (!Number.isSafeInteger(qtyX100) || qtyX100 <= 0) {
    throw new EstimateError(422, "qty_must_be_positive");
  }
  return mulDivHalfUp(unitPriceCents, qtyX100, 100);
}

export async function createEstimate(
  scope: TenantScope,
  jobId: string,
  options: EstimateOptionInput[],
): Promise<{ id: string; options: { id: string; tier: string; totalCents: number }[] }> {
  if (options.length === 0 || options.length > 3) {
    throw new EstimateError(422, "one_to_three_options");
  }
  return withTenant(scope, async (c) => {
    const est = await c.query<{ id: string }>(
      `INSERT INTO estimates (tenant_id, job_id, created_by)
       VALUES ($1,$2,$3) RETURNING id`,
      [scope.tenantId, jobId, scope.uid],
    );
    const estimateId = est.rows[0]!.id;
    const out: { id: string; tier: string; totalCents: number }[] = [];
    for (const opt of options) {
      const totals = opt.lines.map((l) => lineTotalCents(l.qtyX100, l.unitPriceCents));
      const totalCents = totals.reduce((s, t) => s + t, 0);
      const o = await c.query<{ id: string }>(
        `INSERT INTO estimate_options (tenant_id, estimate_id, tier, title, summary, total_cents)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [scope.tenantId, estimateId, opt.tier, opt.title, opt.summary ?? null, totalCents],
      );
      const optionId = o.rows[0]!.id;
      for (let i = 0; i < opt.lines.length; i++) {
        const l = opt.lines[i]!;
        await c.query(
          `INSERT INTO estimate_lines (tenant_id, option_id, pricebook_item_id,
             description, qty_x100, unit_price_cents, line_total_cents, line_no)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            scope.tenantId, optionId, l.pricebookItemId ?? null, l.description,
            l.qtyX100, l.unitPriceCents, totals[i], i + 1,
          ],
        );
      }
      out.push({ id: optionId, tier: opt.tier, totalCents });
    }
    return { id: estimateId, options: out };
  });
}

/**
 * Customer picks an option: the estimate is approved and the job's contract is
 * AWARDED at that option's total — the WIP/billing baseline. LIR event emitted.
 *
 * ⛔ This used to be `UPDATE jobs SET contract_cents = $2`, which OVERWRITES.
 * Approving a second estimate on the same job silently destroyed the first
 * contract value, and every number downstream (percent-complete, earned
 * revenue, over/under-billing, the CPA pack) re-based onto the new figure with
 * no record that anything had changed. It was reachable from the customer
 * PORTAL — a homeowner tapping approve on a second proposal could do it — at
 * aal1, with no financials wall.
 *
 * Now the award is the first row in the job's contract-movement ledger, and a
 * second award is refused rather than absorbed. **Changing an awarded contract
 * is a change order** (migration 0043), which is a document with a number, a
 * reason and an approver, not a side effect of a second estimate.
 */
export async function approveEstimate(
  scope: TenantScope,
  estimateId: string,
  optionId: string,
): Promise<{ jobId: string; contractCents: number }> {
  return withTenant(scope, async (c) => {
    const opt = await c.query<{ total_cents: string; estimate_id: string }>(
      "SELECT total_cents, estimate_id FROM estimate_options WHERE id = $1",
      [optionId],
    );
    const option = opt.rows[0];
    if (!option || option.estimate_id !== estimateId) {
      throw new EstimateError(404, "option_not_found");
    }
    const est = await c.query<{ job_id: string }>(
      "SELECT job_id FROM estimates WHERE id = $1", [estimateId],
    );
    const jobId = est.rows[0]!.job_id;
    const contractCents = Number(option.total_cents);

    // Lock the job row. Two approvals racing — the office and the customer
    // tapping at the same moment — must not both write an award.
    const job = await c.query<{ id: string }>(
      "SELECT id FROM jobs WHERE id = $1 FOR UPDATE",
      [jobId],
    );
    if (job.rowCount === 0) throw new EstimateError(404, "job_not_found");

    const prior = await c.query<{ n: string }>(
      "SELECT count(*) AS n FROM contract_movements WHERE job_id = $1",
      [jobId],
    );
    if (Number(prior.rows[0]!.n) > 0) {
      // Deliberately a hard refusal, not a silent second award. The office can
      // still change the price — through a change order, where the delta and
      // the reason are recorded and somebody approves it.
      throw new EstimateError(409, "contract_already_awarded");
    }

    await c.query(
      "UPDATE estimates SET status = 'approved', approved_option_id = $2 WHERE id = $1",
      [estimateId, optionId],
    );
    await c.query(
      `INSERT INTO contract_movements
         (tenant_id, job_id, seq, kind, delta_cents, reason, estimate_id, created_by)
       VALUES ($1, $2, 1, 'award', $3, 'Estimate approved', $4, $5)`,
      [scope.tenantId, jobId, contractCents, estimateId, scope.uid],
    );
    // The cache. The tie-out trigger checks this against the movements, so it
    // cannot drift from the history that now owns it.
    await c.query("UPDATE jobs SET contract_cents = $2 WHERE id = $1", [jobId, contractCents]);
    await c.query(
      `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid)
       VALUES ($1, 'estimate_approved', 'job', $2, $3)`,
      [scope.tenantId, jobId, scope.uid],
    );
    return { jobId, contractCents };
  });
}
