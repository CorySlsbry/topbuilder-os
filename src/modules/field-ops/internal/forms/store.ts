import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import {
  completeness,
  explainCompleteness,
  jobCompletionGate,
  type Completeness,
  type FormItemKind,
  type JobGateResult,
} from "./completeness";

export class FormError extends HttpError {
  constructor(status: 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

const KINDS: readonly FormItemKind[] = ["check", "text", "number", "photo", "signature"];

export interface TemplateItemInput {
  kind: FormItemKind;
  label: string;
  hint?: string;
  required?: boolean;
}

export interface TemplateInput {
  name: string;
  description?: string;
  requiredForCompletion?: boolean;
  items: TemplateItemInput[];
}

export interface TemplateRow {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  requiredForCompletion: boolean;
  items: { id: string; position: number; kind: FormItemKind; label: string; hint: string; required: boolean }[];
}

// ------------------------------------------------------------- templates
export async function listTemplates(
  scope: TenantScope,
  opts: { includeArchived?: boolean } = {},
): Promise<TemplateRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<TemplateRow & { items: TemplateRow["items"] | null }>(
      `SELECT t.id, t.name, t.description, t.archived,
              t.required_for_completion AS "requiredForCompletion",
              COALESCE(
                (SELECT json_agg(json_build_object(
                          'id', i.id, 'position', i.position, 'kind', i.kind,
                          'label', i.label, 'hint', i.hint, 'required', i.required)
                        ORDER BY i.position)
                   FROM form_template_items i WHERE i.template_id = t.id),
                '[]'::json) AS items
         FROM form_templates t
        WHERE ($1::boolean OR NOT t.archived)
        ORDER BY t.archived, t.name`,
      [Boolean(opts.includeArchived)],
    );
    return rows.map((r) => ({ ...r, items: r.items ?? [] }));
  });
}

function validateItems(items: TemplateItemInput[]): void {
  if (items.length > 100) throw new FormError(422, "too_many_items");
  for (const i of items) {
    if (!KINDS.includes(i.kind)) throw new FormError(422, "unknown_item_kind");
    if (!i.label?.trim()) throw new FormError(422, "item_needs_a_label");
  }
}

/**
 * Create or replace a template — ⛔ THE WHOLE ORDERED ARRAY, IN ONE WRITE.
 *
 * Per-item endpoints would mean two people reordering at once produce an order
 * neither of them chose, or two items at position 3. Here the client sends the
 * document, the server deletes every item and rewrites them inside ONE
 * transaction, and `position` comes from the array index — never from the
 * client. There is no ordering race because there is no partial order to race
 * on.
 *
 * The cost is that a concurrent edit is last-writer-wins on the whole
 * template. That is the right trade for a document a shop edits at a desk a
 * few times a year, and it is honest: the alternative loses an ORDER rather
 * than an edit, which is far harder to notice.
 */
export async function saveTemplate(
  scope: TenantScope,
  input: TemplateInput,
  templateId?: string,
): Promise<string> {
  if (!input.name?.trim()) throw new FormError(422, "template_needs_a_name");
  validateItems(input.items);

  return withTenant(scope, async (c) => {
    let id = templateId;
    if (id) {
      const r = await c.query(
        `UPDATE form_templates
            SET name = $2, description = $3, required_for_completion = $4,
                updated_at = now()
          WHERE id = $1 RETURNING id`,
        [id, input.name.trim(), input.description ?? "", Boolean(input.requiredForCompletion)],
      );
      if (r.rowCount === 0) throw new FormError(404, "template_not_found");
      await c.query(`DELETE FROM form_template_items WHERE template_id = $1`, [id]);
    } else {
      const r = await c.query<{ id: string }>(
        `INSERT INTO form_templates
           (tenant_id, name, description, required_for_completion, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [
          scope.tenantId,
          input.name.trim(),
          input.description ?? "",
          Boolean(input.requiredForCompletion),
          scope.uid,
        ],
      );
      id = r.rows[0]!.id;
    }

    for (const [position, item] of input.items.entries()) {
      await c.query(
        `INSERT INTO form_template_items
           (tenant_id, template_id, position, kind, label, hint, required)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          scope.tenantId,
          id,
          position,
          item.kind,
          item.label.trim(),
          item.hint ?? "",
          Boolean(item.required),
        ],
      );
    }
    return id!;
  });
}

/** Archive, never delete: a deleted template would erase forms already signed. */
export async function archiveTemplate(
  scope: TenantScope,
  templateId: string,
  archived: boolean,
): Promise<void> {
  await withTenant(scope, async (c) => {
    const r = await c.query(
      `UPDATE form_templates SET archived = $2, updated_at = now() WHERE id = $1`,
      [templateId, archived],
    );
    if (r.rowCount === 0) throw new FormError(404, "template_not_found");
  });
}

// ------------------------------------------------------------- job forms
export interface JobFormRow {
  id: string;
  templateId: string;
  name: string;
  status: "open" | "complete";
  requiredForCompletion: boolean;
  completedAt: string | null;
  completedBy: string;
  items: {
    id: string;
    position: number;
    kind: FormItemKind;
    label: string;
    hint: string;
    required: boolean;
    checked: boolean | null;
    valueText: string;
    valueNumber: number | null;
    attachmentId: string | null;
    signedName: string;
    answeredBy: string;
    answeredAt: string | null;
  }[];
  completeness: Completeness;
  explain: string;
}

export async function listJobForms(scope: TenantScope, jobId: string): Promise<JobFormRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<Omit<JobFormRow, "completeness" | "explain">>(
      `SELECT f.id, f.template_id AS "templateId", f.name, f.status,
              COALESCE(t.required_for_completion, false) AS "requiredForCompletion",
              f.completed_at::text AS "completedAt", f.completed_by AS "completedBy",
              COALESCE(
                (SELECT json_agg(json_build_object(
                          'id', i.id, 'position', i.position, 'kind', i.kind,
                          'label', i.label, 'hint', i.hint, 'required', i.required,
                          'checked', i.checked, 'valueText', i.value_text,
                          'valueNumber', i.value_number, 'attachmentId', i.attachment_id,
                          'signedName', i.signed_name, 'answeredBy', i.answered_by,
                          'answeredAt', i.answered_at::text)
                        ORDER BY i.position)
                   FROM job_form_items i WHERE i.form_id = f.id),
                '[]'::json) AS items
         FROM job_forms f
         LEFT JOIN form_templates t ON t.id = f.template_id
        WHERE f.job_id = $1
        ORDER BY f.created_at`,
      [jobId],
    );
    return rows.map((r) => {
      const items = (r.items ?? []).map((i) => ({
        ...i,
        // pg returns numeric as a string; a string reaching the money-free
        // math here would still make `0` behave like a truthy answer.
        valueNumber: i.valueNumber === null ? null : Number(i.valueNumber),
      }));
      const c2 = completeness(items);
      return { ...r, items, completeness: c2, explain: explainCompleteness(c2) };
    });
  });
}

/** Attach a template to a job, SNAPSHOTTING its items as they are today. */
export async function attachForm(
  scope: TenantScope,
  jobId: string,
  templateId: string,
): Promise<string> {
  return withTenant(scope, async (c) => {
    const tpl = await c.query<{ name: string }>(
      `SELECT name FROM form_templates WHERE id = $1 AND NOT archived`,
      [templateId],
    );
    if (tpl.rows.length === 0) throw new FormError(404, "template_not_found");

    const ins = await c.query<{ id: string }>(
      `INSERT INTO job_forms (tenant_id, job_id, template_id, name, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, job_id, template_id) DO NOTHING
       RETURNING id`,
      [scope.tenantId, jobId, templateId, tpl.rows[0]!.name, scope.uid],
    );
    if (ins.rows.length === 0) throw new FormError(409, "form_already_on_this_job");
    const formId = ins.rows[0]!.id;

    // ⛔ SNAPSHOT, not a join. What a person was asked — and answered — must
    // not change because somebody edited the template next month.
    await c.query(
      `INSERT INTO job_form_items
         (tenant_id, form_id, position, kind, label, hint, required)
       SELECT $1, $2, position, kind, label, hint, required
         FROM form_template_items WHERE template_id = $3 ORDER BY position`,
      [scope.tenantId, formId, templateId],
    );
    return formId;
  });
}

export interface AnswerInput {
  checked?: boolean | null;
  valueText?: string;
  valueNumber?: number | null;
  attachmentId?: string | null;
  signedName?: string;
}

/**
 * Answer ONE item.
 *
 * The opposite choice from the template PUT above, and for the opposite
 * reason: a tech on a roof with two bars must not lose a whole form because
 * the last save failed. One item at a time, through the existing outbox, so a
 * dropped request costs one answer and retries itself.
 *
 * A completed form is closed to edits. Reopening is a deliberate act with its
 * own call, because silently editing a signed record is the thing a signature
 * exists to prevent.
 */
export async function answerItem(
  scope: TenantScope,
  itemId: string,
  answer: AnswerInput,
): Promise<void> {
  await withTenant(scope, async (c) => {
    const row = await c.query<{ kind: FormItemKind; status: string }>(
      `SELECT i.kind, f.status
         FROM job_form_items i JOIN job_forms f ON f.id = i.form_id
        WHERE i.id = $1`,
      [itemId],
    );
    const found = row.rows[0];
    if (!found) throw new FormError(404, "item_not_found");
    if (found.status === "complete") throw new FormError(409, "form_already_complete");

    await c.query(
      `UPDATE job_form_items
          SET checked = $2, value_text = $3, value_number = $4,
              attachment_id = $5, signed_name = $6,
              answered_by = $7, answered_at = now()
        WHERE id = $1`,
      [
        itemId,
        answer.checked ?? null,
        answer.valueText ?? "",
        answer.valueNumber ?? null,
        answer.attachmentId ?? null,
        (answer.signedName ?? "").trim(),
        scope.uid,
      ],
    );
  });
}

/**
 * Mark a form finished.
 *
 * Refuses while any REQUIRED item is unanswered, and the refusal names them —
 * the same rule the screen shows, enforced here so it is true rather than
 * displayed.
 */
export async function completeForm(scope: TenantScope, formId: string): Promise<void> {
  await withTenant(scope, async (c) => {
    const items = await c.query<{
      kind: FormItemKind;
      label: string;
      required: boolean;
      checked: boolean | null;
      value_text: string;
      value_number: string | null;
      attachment_id: string | null;
      signed_name: string;
    }>(
      `SELECT i.kind, i.label, i.required, i.checked, i.value_text,
              i.value_number, i.attachment_id, i.signed_name
         FROM job_form_items i
         JOIN job_forms f ON f.id = i.form_id
        WHERE i.form_id = $1 AND f.status = 'open'
        FOR UPDATE OF i`,
      [formId],
    );
    const state = completeness(
      items.rows.map((r) => ({
        kind: r.kind,
        label: r.label,
        required: r.required,
        checked: r.checked,
        valueText: r.value_text,
        valueNumber: r.value_number === null ? null : Number(r.value_number),
        attachmentId: r.attachment_id,
        signedName: r.signed_name,
      })),
    );
    if (!state.canComplete) throw new FormError(422, `form_incomplete:${state.missing.join(", ")}`);

    const r = await c.query(
      `UPDATE job_forms
          SET status = 'complete', completed_at = now(), completed_by = $2
        WHERE id = $1 AND status = 'open'`,
      [formId, scope.uid],
    );
    if (r.rowCount === 0) throw new FormError(409, "form_already_complete");
  });
}

/** Reopen a finished form. Deliberate, and it clears the completion record. */
export async function reopenForm(scope: TenantScope, formId: string): Promise<void> {
  await withTenant(scope, async (c) => {
    const r = await c.query(
      `UPDATE job_forms SET status = 'open', completed_at = NULL, completed_by = ''
        WHERE id = $1 AND status = 'complete'`,
      [formId],
    );
    if (r.rowCount === 0) throw new FormError(409, "form_not_complete");
  });
}

// -------------------------------------------------------- completion gate
export interface FormSettings {
  gateCompletion: boolean;
}

export async function getFormSettings(scope: TenantScope): Promise<FormSettings> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ gate_completion: boolean }>(
      `SELECT gate_completion FROM job_form_settings WHERE tenant_id = $1`,
      [scope.tenantId],
    );
    // No row means the shop has never touched it, which means OFF. Written out
    // rather than left to a truthiness check, because this default decides
    // whether a crew can close a job.
    return { gateCompletion: rows[0]?.gate_completion ?? false };
  });
}

export async function setFormSettings(
  scope: TenantScope,
  gateCompletion: boolean,
): Promise<FormSettings> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ gate_completion: boolean }>(
      `INSERT INTO job_form_settings (tenant_id, gate_completion, updated_by, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (tenant_id) DO UPDATE
         SET gate_completion = EXCLUDED.gate_completion,
             updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING gate_completion`,
      [scope.tenantId, gateCompletion, scope.uid],
    );
    const row = rows[0];
    if (!row) throw new Error("job_form_settings_write_matched_no_rows");
    return { gateCompletion: row.gate_completion };
  });
}

/**
 * Can this job be marked complete? Asked by the status route BEFORE it writes.
 *
 * Returns a structured answer rather than throwing, because the job screen
 * also wants to SHOW the reason before somebody presses the button.
 */
export async function checkJobCompletionGate(
  scope: TenantScope,
  jobId: string,
): Promise<JobGateResult> {
  return withTenant(scope, async (c) => {
    const settings = await c.query<{ gate_completion: boolean }>(
      `SELECT gate_completion FROM job_form_settings WHERE tenant_id = $1`,
      [scope.tenantId],
    );
    const gateEnabled = settings.rows[0]?.gate_completion ?? false;
    if (!gateEnabled) return jobCompletionGate(false, []);

    const forms = await c.query<{
      formId: string;
      name: string;
      requiredForCompletion: boolean;
      status: "open" | "complete";
    }>(
      `SELECT f.id AS "formId", f.name, f.status,
              COALESCE(t.required_for_completion, false) AS "requiredForCompletion"
         FROM job_forms f
         LEFT JOIN form_templates t ON t.id = f.template_id
        WHERE f.job_id = $1`,
      [jobId],
    );
    return jobCompletionGate(true, forms.rows);
  });
}
