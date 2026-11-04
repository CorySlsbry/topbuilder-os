import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import {
  changeOrderLineTotal,
  changeOrderTotalCents,
  checkChangeOrder,
  explainContract,
  summarizeContract,
  type ChangeOrderLineInput,
  type ContractSummary,
} from "./contract";
import { EstimateError } from "./store";

/**
 * Change orders — the document that legitimately moves an awarded contract.
 *
 * `approveEstimate` refuses a second award (migration 0043) precisely so that
 * this exists instead: a numbered document with a scope, a price, a reason and
 * somebody's approval on it. Contractors bleed money at exactly this seam —
 * work gets added on a Tuesday, nobody writes it down, and it is argued about
 * at final billing.
 *
 * Approving one writes a signed row into `contract_movements` and updates the
 * cached `jobs.contract_cents`, which the tie-out trigger then checks. It
 * posts NOTHING to the general ledger: the contract is an operational
 * baseline, and revenue recognises through WIP and invoices. Posting here
 * would double-count the moment the work is invoiced.
 */

export interface ChangeOrderRow {
  id: string;
  coNo: number;
  jobId: string;
  status: "draft" | "sent" | "approved" | "declined" | "void";
  title: string;
  reason: string;
  totalCents: number;
  approvedBy: string;
  approvedVia: string;
  approvedAt: string | null;
  createdAt: string;
  lines: { description: string; qtyX100: number; unitPriceCents: number; lineTotalCents: number }[];
}

export interface JobContract {
  summary: ContractSummary;
  explain: string;
  changeOrders: ChangeOrderRow[];
}

const SELECT_CO = `
  SELECT co.id, co.co_no AS "coNo", co.job_id AS "jobId", co.status, co.title,
         co.reason, co.total_cents AS "totalCents", co.approved_by AS "approvedBy",
         co.approved_via AS "approvedVia", co.approved_at::text AS "approvedAt",
         co.created_at::text AS "createdAt",
         COALESCE(
           (SELECT json_agg(json_build_object(
                     'description', l.description,
                     'qtyX100', l.qty_x100,
                     'unitPriceCents', l.unit_price_cents::bigint,
                     'lineTotalCents', l.line_total_cents::bigint)
                    ORDER BY l.line_no)
              FROM change_order_lines l WHERE l.change_order_id = co.id),
           '[]'::json) AS lines
    FROM change_orders co`;

/** pg hands bigint back as a string; normalise once, here, at the boundary. */
function normalise(r: Record<string, unknown>): ChangeOrderRow {
  const row = r as unknown as ChangeOrderRow & { totalCents: string | number };
  return {
    ...row,
    coNo: Number(row.coNo),
    totalCents: Number(row.totalCents),
    lines: (row.lines ?? []).map((l) => ({
      ...l,
      unitPriceCents: Number(l.unitPriceCents),
      lineTotalCents: Number(l.lineTotalCents),
    })),
  };
}

/** The job's whole contract story: where it started, what moved it, where it
 *  is now — plus every change order, whatever its state. */
export async function getJobContract(scope: TenantScope, jobId: string): Promise<JobContract> {
  return withTenant(scope, async (c) => {
    const movements = await c.query<{ seq: number; kind: string; delta_cents: string }>(
      `SELECT seq, kind, delta_cents FROM contract_movements
        WHERE job_id = $1 ORDER BY seq`,
      [jobId],
    );
    const summary = summarizeContract(
      movements.rows.map((m) => ({
        seq: m.seq,
        kind: m.kind as "award" | "change-order" | "correction",
        deltaCents: Number(m.delta_cents),
      })),
    );
    const cos = await c.query(`${SELECT_CO} WHERE co.job_id = $1 ORDER BY co.co_no`, [jobId]);
    return {
      summary,
      explain: explainContract(summary, (cents) =>
        (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }),
      ),
      changeOrders: cos.rows.map(normalise),
    };
  });
}

export interface CreateChangeOrderInput {
  jobId: string;
  title: string;
  reason?: string;
  lines: ChangeOrderLineInput[];
}

export async function createChangeOrder(
  scope: TenantScope,
  input: CreateChangeOrderInput,
): Promise<ChangeOrderRow> {
  if (!input.title.trim()) throw new EstimateError(422, "title_required");
  if (input.lines.length === 0) throw new EstimateError(422, "no_lines");

  const total = changeOrderTotalCents(input.lines);
  return withTenant(scope, async (c) => {
    const job = await c.query<{ contract_cents: string }>(
      "SELECT contract_cents FROM jobs WHERE id = $1",
      [input.jobId],
    );
    if (job.rowCount === 0) throw new EstimateError(404, "job_not_found");

    // Refuse a zero or an over-deduct HERE, with a sentence a person can act
    // on. Left to the database it surfaces as a raw 23514 on
    // `contract_cents >= 0`, which tells the office nothing.
    const ok = checkChangeOrder(Number(job.rows[0]!.contract_cents), total);
    if (!ok.ok) throw new EstimateError(422, ok.code);

    const coNo = Number(
      (await c.query<{ value: string }>("SELECT app.next_counter('change_order_no') AS value"))
        .rows[0]!.value,
    );
    const ins = await c.query<{ id: string }>(
      `INSERT INTO change_orders (tenant_id, job_id, co_no, title, reason, total_cents, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [scope.tenantId, input.jobId, coNo, input.title.trim(), (input.reason ?? "").trim(), total, scope.uid],
    );
    const id = ins.rows[0]!.id;

    let lineNo = 0;
    for (const l of input.lines) {
      lineNo++;
      await c.query(
        `INSERT INTO change_order_lines
           (tenant_id, change_order_id, description, qty_x100, unit_price_cents,
            line_total_cents, line_no)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          scope.tenantId,
          id,
          l.description.trim().slice(0, 300),
          l.qtyX100,
          l.unitPriceCents,
          changeOrderLineTotal(l.qtyX100, l.unitPriceCents),
          lineNo,
        ],
      );
    }
    await c.query(
      `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid)
       VALUES ($1,'change_order_created','job',$2,$3)`,
      [scope.tenantId, input.jobId, scope.uid],
    );
    const row = await c.query(`${SELECT_CO} WHERE co.id = $1`, [id]);
    return normalise(row.rows[0] as Record<string, unknown>);
  });
}

/** Put it in front of the customer. Only a draft can be sent. */
export async function sendChangeOrder(scope: TenantScope, id: string): Promise<void> {
  await withTenant(scope, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE change_orders SET status = 'sent' WHERE id = $1 AND status = 'draft'`,
      [id],
    );
    if (rowCount === 0) throw new EstimateError(409, "not_a_draft");
  });
}

/**
 * Approve — the only path that moves the contract.
 *
 * Shared by the office route and the customer portal, so the two can never
 * drift on the part that matters. `via` records WHICH of them said yes, which
 * is exactly what gets argued about later.
 */
export async function approveChangeOrderTx(
  c: PoolClient,
  scope: TenantScope,
  id: string,
  via: "office" | "customer",
): Promise<{ jobId: string; contractCents: number; coNo: number }> {
  // Lock it. Two approvals racing — the office recording a verbal yes while
  // the customer taps approve — must move the contract exactly once.
  const { rows } = await c.query<{
    job_id: string;
    co_no: number;
    status: string;
    total_cents: string;
  }>(
    `SELECT job_id, co_no, status, total_cents FROM change_orders
      WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const co = rows[0];
  if (!co) throw new EstimateError(404, "change_order_not_found");
  if (co.status === "approved") throw new EstimateError(409, "change_order_already_decided");
  if (co.status === "void" || co.status === "declined") {
    throw new EstimateError(409, "change_order_already_decided");
  }

  const job = await c.query<{ contract_cents: string }>(
    "SELECT contract_cents FROM jobs WHERE id = $1 FOR UPDATE",
    [co.job_id],
  );
  const current = Number(job.rows[0]!.contract_cents);
  const delta = Number(co.total_cents);
  const ok = checkChangeOrder(current, delta);
  if (!ok.ok) throw new EstimateError(422, ok.code);

  const seq = Number(
    (
      await c.query<{ n: string }>(
        "SELECT COALESCE(max(seq), 0) + 1 AS n FROM contract_movements WHERE job_id = $1",
        [co.job_id],
      )
    ).rows[0]!.n,
  );
  await c.query(
    `INSERT INTO contract_movements
       (tenant_id, job_id, seq, kind, delta_cents, reason, change_order_id, created_by)
     VALUES ($1,$2,$3,'change-order',$4,$5,$6,$7)`,
    [scope.tenantId, co.job_id, seq, delta, `CO #${co.co_no}`, id, scope.uid],
  );
  const contractCents = current + delta;
  // The tie-out trigger checks this against the movements we just wrote.
  await c.query("UPDATE jobs SET contract_cents = $2 WHERE id = $1", [co.job_id, contractCents]);
  await c.query(
    `UPDATE change_orders
        SET status = 'approved', approved_by = $2, approved_via = $3, approved_at = now()
      WHERE id = $1`,
    [id, scope.uid, via],
  );
  await c.query(
    `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid)
     VALUES ($1,'change_order_approved','job',$2,$3)`,
    [scope.tenantId, co.job_id, scope.uid],
  );
  return { jobId: co.job_id, contractCents, coNo: co.co_no };
}

export async function approveChangeOrder(
  scope: TenantScope,
  id: string,
  via: "office" | "customer" = "office",
): Promise<{ jobId: string; contractCents: number; coNo: number }> {
  return withTenant(scope, (c) => approveChangeOrderTx(c, scope, id, via));
}

export async function declineChangeOrder(
  scope: TenantScope,
  id: string,
  note = "",
): Promise<void> {
  await withTenant(scope, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE change_orders SET status = 'declined', decided_note = $2
        WHERE id = $1 AND status IN ('draft','sent')`,
      [id, note.trim().slice(0, 300)],
    );
    if (rowCount === 0) throw new EstimateError(409, "change_order_already_decided");
  });
}

/**
 * Void an APPROVED change order.
 *
 * Not an edit and not a delete: it writes a REVERSING movement, exactly the
 * shape `voidInvoice` uses in the ledger. The original movement stays, because
 * the history of a contract is the point — someone asking "why is this job
 * $4,200 more than the estimate?" needs to see both rows.
 */
export async function voidChangeOrder(scope: TenantScope, id: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new EstimateError(422, "reason_required");
  await withTenant(scope, async (c) => {
    const { rows } = await c.query<{ job_id: string; co_no: number; total_cents: string; status: string }>(
      "SELECT job_id, co_no, total_cents, status FROM change_orders WHERE id = $1 FOR UPDATE",
      [id],
    );
    const co = rows[0];
    if (!co) throw new EstimateError(404, "change_order_not_found");
    if (co.status !== "approved") throw new EstimateError(409, "only_approved_can_be_voided");

    const job = await c.query<{ contract_cents: string }>(
      "SELECT contract_cents FROM jobs WHERE id = $1 FOR UPDATE",
      [co.job_id],
    );
    const current = Number(job.rows[0]!.contract_cents);
    const reversal = -Number(co.total_cents);
    const ok = checkChangeOrder(current, reversal);
    if (!ok.ok) throw new EstimateError(422, ok.code);

    const seq = Number(
      (
        await c.query<{ n: string }>(
          "SELECT COALESCE(max(seq), 0) + 1 AS n FROM contract_movements WHERE job_id = $1",
          [co.job_id],
        )
      ).rows[0]!.n,
    );
    await c.query(
      `INSERT INTO contract_movements
         (tenant_id, job_id, seq, kind, delta_cents, reason, change_order_id, created_by)
       VALUES ($1,$2,$3,'correction',$4,$5,$6,$7)`,
      [scope.tenantId, co.job_id, seq, reversal, `Void CO #${co.co_no}: ${reason.trim()}`, id, scope.uid],
    );
    await c.query("UPDATE jobs SET contract_cents = $2 WHERE id = $1", [
      co.job_id,
      current + reversal,
    ]);
    await c.query(
      `UPDATE change_orders SET status = 'void', decided_note = $2 WHERE id = $1`,
      [id, reason.trim().slice(0, 300)],
    );
  });
}
