import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import {
  findPreset,
  presetRows,
  type CostKind,
} from "./cost-code-library";

export class CostCodeError extends HttpError {
  constructor(status: 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

export interface CostCodeRow {
  code: string;
  name: string;
  kind: CostKind;
  division: string | null;
  sortOrder: number;
  glAccountCode: string | null;
  isActive: boolean;
  source: string;
  /** How many job costs already point at this code — what makes retiring it
   *  a decision rather than a click. */
  useCount: number;
}

/**
 * The tenant's cost codes, in presentation order, with the usage count that
 * turns "deactivate" from a guess into an informed choice.
 */
export async function listCostCodes(
  scope: TenantScope,
  opts: { includeInactive?: boolean } = {},
): Promise<CostCodeRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      code: string;
      name: string;
      kind: CostKind;
      division: string | null;
      sort_order: number;
      gl_account_code: string | null;
      is_active: boolean;
      source: string;
      uses: string;
    }>(
      `SELECT cc.code, cc.name, cc.kind, cc.division, cc.sort_order,
              cc.gl_account_code, cc.is_active, cc.source,
              COALESCE(u.n, 0) AS uses
         FROM cost_codes cc
         LEFT JOIN (
           SELECT cost_code, COUNT(*) AS n FROM cost_entries GROUP BY cost_code
         ) u ON u.cost_code = cc.code
        WHERE ($1::bool OR cc.is_active)
        ORDER BY cc.sort_order, cc.code`,
      [opts.includeInactive ?? false],
    );
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      kind: r.kind,
      division: r.division,
      sortOrder: Number(r.sort_order),
      glAccountCode: r.gl_account_code,
      isActive: r.is_active,
      source: r.source,
      useCount: Number(r.uses),
    }));
  });
}

/**
 * Lay a preset down.
 *
 * ⛔ NEVER OVERWRITES. `ON CONFLICT DO NOTHING` means seeding twice is safe,
 * seeding a second trade on top of the first merges the two, and a code the
 * shop has renamed keeps its name. The alternative — DO UPDATE — would
 * silently undo a shop's own edits every time somebody clicked the button
 * again, and they would have no way to know it happened.
 */
export async function seedCostCodePreset(
  scope: TenantScope,
  presetKey: string,
): Promise<{ added: number; alreadyThere: number }> {
  const preset = findPreset(presetKey);
  if (!preset) throw new CostCodeError(422, "unknown_preset");
  const rows = presetRows(preset);

  return withTenant(scope, async (c) => {
    // One statement rather than a loop: ~25 round trips for a button click is
    // a slow screen for no reason, and the whole set should land or none of
    // it should.
    const { rowCount } = await c.query(
      `INSERT INTO cost_codes (tenant_id, code, name, kind, division, sort_order, source)
       SELECT $1, x.code, x.name, x.kind, x.division, x.sort_order, 'seed'
         FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::int[])
              AS x(code, name, kind, division, sort_order)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [
        scope.tenantId,
        rows.map((r) => r.code),
        rows.map((r) => r.name),
        rows.map((r) => r.kind),
        rows.map((r) => r.division),
        rows.map((r) => r.sortOrder),
      ],
    );
    const added = rowCount ?? 0;
    return { added, alreadyThere: rows.length - added };
  });
}

export interface CostCodeInput {
  code: string;
  name: string;
  kind: CostKind;
  division?: string | null;
  glAccountCode?: string | null;
  isActive?: boolean;
}

/** Create or edit one code. The CODE itself is the key and never changes —
 *  renaming a code that historical job costs point at would rewrite history
 *  on every report that groups by it. Retire it and add a new one instead. */
export async function upsertCostCode(
  scope: TenantScope,
  input: CostCodeInput,
): Promise<void> {
  const code = input.code.trim();
  if (!code) throw new CostCodeError(422, "code_required");
  if (!input.name.trim()) throw new CostCodeError(422, "name_required");

  await withTenant(scope, async (c) => {
    const existing = await c.query<{ code: string }>(
      "SELECT code FROM cost_codes WHERE code = $1",
      [code],
    );
    if (existing.rowCount === 0) {
      // New codes sort after everything seeded, so adding one does not
      // reshuffle a list the shop has got used to.
      const max = await c.query<{ n: number | null }>(
        "SELECT MAX(sort_order) AS n FROM cost_codes",
      );
      await c.query(
        `INSERT INTO cost_codes (tenant_id, code, name, kind, division,
           sort_order, gl_account_code, source, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8)`,
        [
          scope.tenantId, code, input.name.trim(), input.kind,
          input.division?.trim() || null, (Number(max.rows[0]?.n) || 0) + 10,
          input.glAccountCode?.trim() || null, input.isActive ?? true,
        ],
      );
      return;
    }
    await c.query(
      `UPDATE cost_codes
          SET name = $2, kind = $3, division = $4,
              gl_account_code = $5, is_active = $6
        WHERE code = $1`,
      [
        code, input.name.trim(), input.kind, input.division?.trim() || null,
        input.glAccountCode?.trim() || null, input.isActive ?? true,
      ],
    );
  });
}

/**
 * The default cost code for a screen that has to pick one — field capture,
 * a bill line, a bank job-cost answer.
 *
 * Every one of those places used to hardcode `4100`, a NAHB homebuilder
 * account that means nothing to an HVAC shop and grouped the entire business
 * into one bucket. This returns the shop's own first active code, and null
 * when they have none — which the screens render as "set up your cost codes"
 * rather than silently inventing one.
 */
export async function defaultCostCode(scope: TenantScope): Promise<string | null> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ code: string }>(
      "SELECT code FROM cost_codes WHERE is_active ORDER BY sort_order, code LIMIT 1",
    );
    return rows[0]?.code ?? null;
  });
}
