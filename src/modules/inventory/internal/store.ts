import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { postJournalEntryTx } from "@/modules/ledger";
import { createBillTx, ensureVendorTx } from "@/modules/purchasing-ap";
import { DEFAULT_POSTING_ACCOUNTS } from "@/modules/field-ops";
import { extendedCents, receiptAverage } from "./avgcost";

export class InventoryError extends HttpError {
  constructor(status: 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

export const INVENTORY_ACCOUNT = "1310"; // Construction materials inventory
export const SHRINKAGE_ACCOUNT = "3830"; // Building material (cogs)
const JOB_COST = DEFAULT_POSTING_ACCOUNTS.jobCost; // 1430

// ----------------------------------------------------------------- items
export interface ItemInput {
  name: string;
  unit?: string;
  reorderPointX100?: number;
  reorderQtyX100?: number;
  preferredVendor?: string;
}

export interface ItemRow {
  id: string;
  name: string;
  unit: string;
  qtyOnHandX100: number;
  avgUnitCostCents: number;
  reorderPointX100: number;
  reorderQtyX100: number;
  preferredVendor: string;
  low: boolean;
}

export async function createItem(scope: TenantScope, input: ItemInput): Promise<string> {
  return withTenant(scope, async (c) => {
    try {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO inventory_items
           (tenant_id, name, unit, reorder_point_x100, reorder_qty_x100, preferred_vendor)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          scope.tenantId,
          input.name.trim(),
          input.unit ?? "ea",
          input.reorderPointX100 ?? 0,
          input.reorderQtyX100 ?? 0,
          input.preferredVendor ?? "",
        ],
      );
      return rows[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new InventoryError(409, "item_exists");
      }
      throw err;
    }
  });
}

export async function listItems(scope: TenantScope): Promise<ItemRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT id, name, unit,
              qty_on_hand_x100 AS "qtyOnHandX100",
              avg_unit_cost_cents AS "avgUnitCostCents",
              reorder_point_x100 AS "reorderPointX100",
              reorder_qty_x100 AS "reorderQtyX100",
              preferred_vendor AS "preferredVendor"
         FROM inventory_items WHERE active ORDER BY name`,
    );
    return (rows as (Omit<ItemRow, "low"> & Record<string, string>)[]).map((r) => {
      const qty = Number(r.qtyOnHandX100);
      const point = Number(r.reorderPointX100);
      return {
        id: r.id as string,
        name: r.name as string,
        unit: r.unit as string,
        qtyOnHandX100: qty,
        avgUnitCostCents: Number(r.avgUnitCostCents),
        reorderPointX100: point,
        reorderQtyX100: Number(r.reorderQtyX100),
        preferredVendor: r.preferredVendor as string,
        low: point > 0 && qty <= point,
      };
    });
  });
}

// -------------------------------------------------------------- receipts
interface ItemLock {
  id: string;
  name: string;
  qty: number;
  avg: number;
}

async function lockItem(c: PoolClient, itemId: string): Promise<ItemLock> {
  const { rows } = await c.query<{
    id: string;
    name: string;
    qty_on_hand_x100: string;
    avg_unit_cost_cents: string;
  }>(
    `SELECT id, name, qty_on_hand_x100, avg_unit_cost_cents
       FROM inventory_items WHERE id = $1 FOR UPDATE`,
    [itemId],
  );
  const r = rows[0];
  if (!r) throw new InventoryError(404, "item_not_found");
  return { id: r.id, name: r.name, qty: Number(r.qty_on_hand_x100), avg: Number(r.avg_unit_cost_cents) };
}

export interface ReceiveInput {
  itemId: string;
  qtyX100: number;
  unitCostCents: number;
  vendorName: string;
  occurredOn: string;
  poId?: string | null;
  memo?: string;
}

/**
 * Receive stock: a vendor bill (DR 1310 inventory / CR 2110 AP) + the stock
 * move + the new moving average — one transaction. The bill flows through
 * the normal AP surface (aging, pay, 1099).
 */
export async function receiveStock(
  scope: TenantScope,
  input: ReceiveInput,
): Promise<{ billId: string; newAvgCents: number; newQtyX100: number }> {
  if (!Number.isInteger(input.qtyX100) || input.qtyX100 <= 0) {
    throw new InventoryError(422, "invalid_qty");
  }
  return withTenant(scope, async (c) => {
    const item = await lockItem(c, input.itemId);
    const value = extendedCents(input.qtyX100, input.unitCostCents);
    if (value <= 0) throw new InventoryError(422, "invalid_cost");

    const vendorId = await ensureVendorTx(c, scope, input.vendorName);
    const billId = await createBillTx(c, scope, {
      vendorId,
      issuedOn: input.occurredOn,
      memo: input.memo || `Stock: ${item.name}`,
      poId: input.poId ?? null,
      lines: [
        {
          amountCents: value,
          accountCode: INVENTORY_ACCOUNT,
          description: `${(input.qtyX100 / 100).toFixed(2)} ${item.name} @ ${(input.unitCostCents / 100).toFixed(2)}`,
        },
      ],
    });

    const bill = await c.query<{ journal_entry_id: string }>(
      `SELECT journal_entry_id FROM bills WHERE id = $1`,
      [billId],
    );
    const newAvg = receiptAverage(item.qty, item.avg, input.qtyX100, input.unitCostCents);
    const newQty = item.qty + input.qtyX100;
    await c.query(
      `UPDATE inventory_items SET qty_on_hand_x100 = $2, avg_unit_cost_cents = $3
        WHERE id = $1`,
      [item.id, newQty, newAvg],
    );
    await c.query(
      `INSERT INTO inventory_moves (tenant_id, item_id, kind, qty_x100, unit_cost_cents,
         po_id, bill_id, journal_entry_id, memo, occurred_on, created_by)
       VALUES ($1,$2,'receipt',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        scope.tenantId,
        item.id,
        input.qtyX100,
        input.unitCostCents,
        input.poId ?? null,
        billId,
        bill.rows[0]!.journal_entry_id,
        input.memo ?? "",
        input.occurredOn,
        scope.uid,
      ],
    );
    return { billId, newAvgCents: newAvg, newQtyX100: newQty };
  });
}

// ---------------------------------------------------------------- issues
export interface IssueInput {
  itemId: string;
  qtyX100: number;
  jobId: string;
  costCode?: string;
  occurredOn: string;
  memo?: string;
}

/**
 * Issue stock to a job at the moving average: DR 1430 with job dims /
 * CR 1310, plus the cost_entries row job costing reads. The item CHECK
 * refuses an issue larger than what's on the shelf.
 */
export async function issueToJob(
  scope: TenantScope,
  input: IssueInput,
): Promise<{ journalEntryId: string; valueCents: number }> {
  if (!Number.isInteger(input.qtyX100) || input.qtyX100 <= 0) {
    throw new InventoryError(422, "invalid_qty");
  }
  return withTenant(scope, async (c) => {
    const item = await lockItem(c, input.itemId);
    if (input.qtyX100 > item.qty) throw new InventoryError(422, "not_enough_on_hand");
    const value = extendedCents(input.qtyX100, item.avg);
    if (value <= 0) throw new InventoryError(422, "zero_value_issue");
    const costCode = input.costCode ?? "4100";
    const memo =
      input.memo || `${(input.qtyX100 / 100).toFixed(2)} ${item.name} from stock`;

    const journalEntryId = await postJournalEntryTx(c, scope, {
      occurredOn: input.occurredOn,
      memo,
      sourceType: "inventory-issue",
      sourceId: item.id,
      lines: [
        { accountCode: JOB_COST, debitCents: value, jobId: input.jobId, costCode },
        { accountCode: INVENTORY_ACCOUNT, creditCents: value },
      ],
    });
    await c.query(
      `UPDATE inventory_items SET qty_on_hand_x100 = qty_on_hand_x100 - $2 WHERE id = $1`,
      [item.id, input.qtyX100],
    );
    await c.query(
      `INSERT INTO inventory_moves (tenant_id, item_id, kind, qty_x100, unit_cost_cents,
         job_id, journal_entry_id, memo, occurred_on, created_by)
       VALUES ($1,$2,'issue',$3,$4,$5,$6,$7,$8,$9)`,
      [
        scope.tenantId,
        item.id,
        -input.qtyX100,
        item.avg,
        input.jobId,
        journalEntryId,
        memo,
        input.occurredOn,
        scope.uid,
      ],
    );
    await c.query(
      `INSERT INTO cost_entries (tenant_id, job_id, cost_code, kind, amount_cents,
         memo, source_type, journal_entry_id, occurred_on, created_by)
       VALUES ($1,$2,$3,'material',$4,$5,'manual',$6,$7,$8)`,
      [
        scope.tenantId,
        input.jobId,
        costCode,
        value,
        memo,
        journalEntryId,
        input.occurredOn,
        scope.uid,
      ],
    );
    return { journalEntryId, valueCents: value };
  });
}

// ----------------------------------------------------------- adjustments
export interface AdjustInput {
  itemId: string;
  /** The counted quantity on the shelf (x100) — the truth to converge on. */
  countedQtyX100: number;
  occurredOn: string;
  memo?: string;
}

/** Count correction at the moving average: shrinkage DR 3830 / CR 1310, a
 *  found surplus the reverse. Zero delta is a no-op error (nothing to fix). */
export async function adjustCount(
  scope: TenantScope,
  input: AdjustInput,
): Promise<{ deltaX100: number; valueCents: number }> {
  if (!Number.isInteger(input.countedQtyX100) || input.countedQtyX100 < 0) {
    throw new InventoryError(422, "invalid_count");
  }
  return withTenant(scope, async (c) => {
    const item = await lockItem(c, input.itemId);
    const delta = input.countedQtyX100 - item.qty;
    if (delta === 0) throw new InventoryError(422, "count_matches_no_adjustment");
    const value = extendedCents(Math.abs(delta), item.avg);
    const memo = input.memo || `Count adjustment: ${item.name}`;

    let journalEntryId: string | null = null;
    if (value > 0) {
      journalEntryId = await postJournalEntryTx(c, scope, {
        occurredOn: input.occurredOn,
        memo,
        sourceType: "inventory-adjust",
        sourceId: item.id,
        lines:
          delta < 0
            ? [
                { accountCode: SHRINKAGE_ACCOUNT, debitCents: value },
                { accountCode: INVENTORY_ACCOUNT, creditCents: value },
              ]
            : [
                { accountCode: INVENTORY_ACCOUNT, debitCents: value },
                { accountCode: SHRINKAGE_ACCOUNT, creditCents: value },
              ],
      });
    }
    await c.query(
      `UPDATE inventory_items SET qty_on_hand_x100 = $2 WHERE id = $1`,
      [item.id, input.countedQtyX100],
    );
    await c.query(
      `INSERT INTO inventory_moves (tenant_id, item_id, kind, qty_x100, unit_cost_cents,
         journal_entry_id, memo, occurred_on, created_by)
       VALUES ($1,$2,'adjust',$3,$4,$5,$6,$7,$8)`,
      [scope.tenantId, item.id, delta, item.avg, journalEntryId, memo, input.occurredOn, scope.uid],
    );
    return { deltaX100: delta, valueCents: delta < 0 ? -value : value };
  });
}

// --------------------------------------------------------- stock reorders
/** Create a stock (no-job) PO — the Restocker's executor. */
export async function createStockPoTx(
  c: PoolClient,
  scope: TenantScope,
  input: { itemId: string; qtyX100: number; vendorName: string; unitCostCents: number },
): Promise<{ poId: string; amountCents: number }> {
  const item = await lockItem(c, input.itemId);
  const amount = extendedCents(input.qtyX100, input.unitCostCents);
  if (amount <= 0) throw new InventoryError(422, "invalid_reorder");
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO purchase_orders (tenant_id, job_id, kind, vendor_name, description,
                                  amount_cents, status, created_by)
     VALUES ($1, NULL, 'po', $2, $3, $4, 'open', $5) RETURNING id`,
    [
      scope.tenantId,
      input.vendorName,
      `Restock: ${(input.qtyX100 / 100).toFixed(2)} × ${item.name}`,
      amount,
      scope.uid,
    ],
  );
  return { poId: rows[0]!.id, amountCents: amount };
}

/** Items at/below their reorder point with no open restock PO yet. */
export async function listLowStock(scope: TenantScope): Promise<ItemRow[]> {
  const items = await listItems(scope);
  const low = items.filter((i) => i.low && i.reorderQtyX100 > 0);
  if (low.length === 0) return [];
  return withTenant(scope, async (c) => {
    const open = await c.query<{ description: string }>(
      `SELECT description FROM purchase_orders
        WHERE job_id IS NULL AND status = 'open' AND description LIKE 'Restock:%'`,
    );
    const openDescs = open.rows.map((r) => r.description);
    return low.filter((i) => !openDescs.some((d) => d.includes(`× ${i.name}`)));
  });
}
