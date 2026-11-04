import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { canSeeAgent, readerCheck, type ActorScope } from "./visibility";

// The self-learning core: every approve / revise / reject / undo teaches.
//   approve -> positive CBR case
//   revise  -> CBR case + a CIPHER preference candidate (quarantined)
//   reject  -> negative case + a one-line reflection
//   undo    -> strongly negative case
// Learned artifacts are versioned, attributed rows — quarantined until a
// distinct-approver quorum activates them, one-click demotable, and
// per-tenant by RLS (a poisoned case cannot surface cross-tenant).

const EFFECTIVENESS: Record<string, number> = {
  accepted: 2,
  edited: 1,
  rejected: -1,
  undone: -2,
};

export { distillPreference } from "./learning-pure";
import { distillPreference } from "./learning-pure";

export async function recordDecisionCase(
  c: PoolClient,
  scope: TenantScope,
  agentKey: string,
  actionId: string,
  proposal: Record<string, unknown>,
  decision: "accepted" | "edited" | "rejected" | "undone",
  edit: Record<string, unknown> | null,
  reflection?: string,
): Promise<void> {
  const caseIns = await c.query<{ id: string }>(
    `INSERT INTO agent_cases
       (tenant_id, agent_key, action_id, situation, proposal, decision, edit,
        reflection, effectiveness)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      scope.tenantId,
      agentKey,
      actionId,
      JSON.stringify({ kind: "action-decision" }),
      JSON.stringify(proposal),
      decision,
      edit ? JSON.stringify(edit) : null,
      reflection ?? (decision === "rejected" ? "Human rejected this proposal; treat similar situations as negative examples." : null),
      EFFECTIVENESS[decision] ?? 0,
    ],
  );
  await c.query(
    `INSERT INTO learning_events (tenant_id, agent_key, event, detail, actor)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      scope.tenantId,
      agentKey,
      `case_${decision}`,
      JSON.stringify({ actionId }),
      scope.uid,
    ],
  );

  // A substantial revise distills into a human-readable preference —
  // "every modification to the plan is a learning experience."
  if (decision === "edited" && edit) {
    const rule = distillPreference(proposal, edit);
    if (rule) {
      await c.query(
        `INSERT INTO agent_preferences (tenant_id, agent_key, rule, source_case_id)
         VALUES ($1,$2,$3,$4)`,
        [scope.tenantId, agentKey, rule, caseIns.rows[0]!.id],
      );
      await c.query(
        `INSERT INTO learning_events (tenant_id, agent_key, event, detail, actor)
         VALUES ($1,$2,'preference_distilled',$3,$4)`,
        [scope.tenantId, agentKey, JSON.stringify({ rule }), scope.uid],
      );
    }
  }
}

// -------------------------------------------------------------- retrieval
export interface CaseRow {
  id: string;
  proposal: Record<string, unknown>;
  decision: string;
  edit: Record<string, unknown> | null;
  reflection: string | null;
  effectiveness: number;
  createdAt: string;
}

/** Few-shot retrieval: recency x effectiveness, per-tenant only (RLS). */
export async function retrieveCases(
  scope: TenantScope,
  agentKey: string,
  limit = 10,
): Promise<CaseRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT id, proposal, decision, edit, reflection, effectiveness,
              created_at::text AS "createdAt"
         FROM agent_cases
        WHERE agent_key = $1
        ORDER BY (effectiveness * 10) + EXTRACT(epoch FROM created_at) / 8640000 DESC,
                 created_at DESC
        LIMIT $2`,
      [agentKey, limit],
    );
    return rows as CaseRow[];
  });
}

// -------------------------------------------------- preference governance
const QUORUM = Number(process.env.AGENT_PREF_QUORUM ?? 3);

export interface PreferenceRow {
  id: string;
  agentKey: string;
  rule: string;
  status: string;
  approvers: string[];
  createdAt: string;
}

/**
 * Learned rules are filtered by the owning agent for the same reason as the
 * cards: a CIPHER preference is distilled FROM a human's edit and quotes the
 * specifics ("code this GC's invoices to the open job, not the closed one").
 */
export async function listPreferences(scope: ActorScope): Promise<PreferenceRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT id, agent_key AS "agentKey", rule, status, approvers,
              created_at::text AS "createdAt"
         FROM agent_preferences ORDER BY created_at DESC LIMIT 100`,
    );
    const check = readerCheck(scope);
    return (rows as PreferenceRow[]).filter((r) => canSeeAgent(check, r.agentKey));
  });
}

/**
 * Quorum approval: a quarantined preference activates only after N DISTINCT
 * approvers (default 3, env-tunable for small shops) — one person's bad
 * edit cannot change behavior alone.
 */
export async function approvePreference(
  scope: TenantScope,
  preferenceId: string,
): Promise<{ status: string; approvals: number; quorum: number }> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ status: string; approvers: string[] }>(
      `SELECT status, approvers FROM agent_preferences WHERE id = $1 FOR UPDATE`,
      [preferenceId],
    );
    const p = rows[0];
    if (!p) throw new Error("preference_not_found");
    if (p.status !== "quarantined") return { status: p.status, approvals: p.approvers.length, quorum: QUORUM };
    const approvers = new Set(p.approvers);
    approvers.add(scope.uid);
    const activated = approvers.size >= QUORUM;
    await c.query(
      `UPDATE agent_preferences SET approvers = $2,
              status = CASE WHEN $3 THEN 'active' ELSE status END,
              activated_at = CASE WHEN $3 THEN now() ELSE activated_at END
        WHERE id = $1`,
      [preferenceId, [...approvers], activated],
    );
    await c.query(
      `INSERT INTO learning_events (tenant_id, agent_key, event, detail, actor)
       SELECT tenant_id, agent_key, $2, $3, $4 FROM agent_preferences WHERE id = $1`,
      [
        preferenceId,
        activated ? "preference_activated" : "preference_approval",
        JSON.stringify({ preferenceId, approvals: approvers.size, quorum: QUORUM }),
        scope.uid,
      ],
    );
    return {
      status: activated ? "active" : "quarantined",
      approvals: approvers.size,
      quorum: QUORUM,
    };
  });
}

/** One-click demotion — every learned artifact is instantly reversible. */
export async function demotePreference(scope: TenantScope, preferenceId: string): Promise<void> {
  await withTenant(scope, async (c) => {
    await c.query(
      `UPDATE agent_preferences SET status = 'demoted' WHERE id = $1`,
      [preferenceId],
    );
    await c.query(
      `INSERT INTO learning_events (tenant_id, agent_key, event, detail, actor)
       SELECT tenant_id, agent_key, 'preference_demoted', $2, $3
         FROM agent_preferences WHERE id = $1`,
      [preferenceId, JSON.stringify({ preferenceId }), scope.uid],
    );
  });
}
