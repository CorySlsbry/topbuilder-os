import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { FieldOpsError } from "./store";

/**
 * Equipment records — the memory of a service business.
 *
 * Which units live at which customer, and what has been done to each. This
 * is why visit #2 is faster than visit #1: the tech arrives knowing it's a
 * 2019 3-ton Goodman with a compressor replaced last fall, instead of
 * starting the interview over. Units anchor service agreements ("we maintain
 * these two systems") and accumulate history through job_equipment.
 *
 * Units are never deleted — a replaced condenser's history explains the new
 * one's sizing. `retired` hides it from pickers; history keeps reading.
 */

export const EQUIPMENT_KINDS = [
  "ac",
  "furnace",
  "heat-pump",
  "mini-split",
  "water-heater",
  "rtu",
  "other",
] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];

export interface EquipmentInput {
  customerId: string;
  label: string;
  kind: EquipmentKind;
  make?: string;
  model?: string;
  serial?: string;
  installedOn?: string | null;
  warrantyUntil?: string | null;
  notes?: string;
}

export interface EquipmentRow {
  id: string;
  customerId: string;
  label: string;
  kind: EquipmentKind;
  make: string;
  model: string;
  serial: string;
  installedOn: string | null;
  warrantyUntil: string | null;
  notes: string;
  retired: boolean;
  /** Jobs that touched this unit, newest first (id, jobNo, name, date). */
  history: { jobId: string; jobNo: number; jobName: string; on: string }[];
}

export async function createEquipment(
  scope: TenantScope,
  input: EquipmentInput,
): Promise<string> {
  if (!input.label.trim()) throw new FieldOpsError(422, "label_required");
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO equipment
         (tenant_id, customer_id, label, kind, make, model, serial,
          installed_on, warranty_until, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        scope.tenantId,
        input.customerId,
        input.label.trim(),
        input.kind,
        input.make?.trim() ?? "",
        input.model?.trim() ?? "",
        input.serial?.trim() ?? "",
        input.installedOn ?? null,
        input.warrantyUntil ?? null,
        input.notes?.trim() ?? "",
        scope.uid,
      ],
    );
    return rows[0]!.id;
  });
}

export async function updateEquipment(
  scope: TenantScope,
  id: string,
  patch: Partial<Omit<EquipmentInput, "customerId">> & { retired?: boolean },
): Promise<void> {
  await withTenant(scope, async (c) => {
    const r = await c.query(
      `UPDATE equipment SET
         label = COALESCE($2, label),
         kind = COALESCE($3, kind),
         make = COALESCE($4, make),
         model = COALESCE($5, model),
         serial = COALESCE($6, serial),
         installed_on = COALESCE($7, installed_on),
         warranty_until = COALESCE($8, warranty_until),
         notes = COALESCE($9, notes),
         retired = COALESCE($10, retired)
       WHERE id = $1`,
      [
        id,
        patch.label?.trim() || null,
        patch.kind ?? null,
        patch.make?.trim() ?? null,
        patch.model?.trim() ?? null,
        patch.serial?.trim() ?? null,
        patch.installedOn ?? null,
        patch.warrantyUntil ?? null,
        patch.notes ?? null,
        patch.retired ?? null,
      ],
    );
    if (r.rowCount === 0) throw new FieldOpsError(404, "equipment_not_found");
  });
}

export async function listEquipment(
  scope: TenantScope,
  customerId: string,
  includeRetired = false,
): Promise<EquipmentRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT e.id, e.customer_id AS "customerId", e.label, e.kind, e.make,
              e.model, e.serial, e.installed_on::text AS "installedOn",
              e.warranty_until::text AS "warrantyUntil", e.notes, e.retired,
              COALESCE(json_agg(json_build_object(
                'jobId', j.id, 'jobNo', j.job_no, 'jobName', j.name,
                'on', j.created_at::date::text) ORDER BY j.created_at DESC)
                FILTER (WHERE j.id IS NOT NULL), '[]') AS history
         FROM equipment e
         LEFT JOIN job_equipment je ON je.equipment_id = e.id
         LEFT JOIN jobs j ON j.id = je.job_id
        WHERE e.customer_id = $1 AND ($2 OR NOT e.retired)
        GROUP BY e.id
        ORDER BY e.retired, e.label`,
      [customerId, includeRetired],
    );
    return rows as EquipmentRow[];
  });
}

/** Tag the units a job touched — per-unit history is this, read backwards. */
export async function linkJobEquipment(
  scope: TenantScope,
  jobId: string,
  equipmentIds: string[],
): Promise<void> {
  await withTenant(scope, async (c) => {
    for (const id of equipmentIds) {
      await c.query(
        `INSERT INTO job_equipment (tenant_id, job_id, equipment_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [scope.tenantId, jobId, id],
      );
    }
  });
}
