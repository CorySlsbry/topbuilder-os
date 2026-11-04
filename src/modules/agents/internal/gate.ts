import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { figureUniverse, verifyFigures } from "./figures";
import { actionsEnabled, AGENT_KEYS, kindAllowed, KINDS } from "./registry";
import { canSeeKind, readerCheck, type ActorScope } from "./visibility";
import { recordDecisionCase } from "./learning";
import { checkScope } from "@/modules/auth-tenancy";

export class AgentError extends HttpError {
  constructor(status: 403 | 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

// ------------------------------------------------------------------ audit
async function audit(
  c: PoolClient,
  tenantId: string,
  actor: string,
  actionId: string | null,
  fromStatus: string | null,
  toStatus: string,
  note?: string,
): Promise<void> {
  await c.query(
    `INSERT INTO audit_events (tenant_id, actor, action_id, from_status, to_status, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tenantId, actor, actionId, fromStatus, toStatus, note ?? null],
  );
}

// ----------------------------------------------------------------- policy
export type AgentMode = "off" | "approve" | "auto";

export async function getMode(
  c: PoolClient,
  tenantId: string,
  agentKey: string,
): Promise<AgentMode> {
  const { rows } = await c.query<{ mode: AgentMode }>(
    `SELECT mode FROM agent_policies WHERE agent_key = $1`,
    [agentKey],
  );
  return rows[0]?.mode ?? "off"; // no row = OFF, fail closed
}

export async function setMode(
  scope: TenantScope,
  agentKey: string,
  mode: AgentMode,
): Promise<void> {
  await withTenant(scope, async (c) => {
    await c.query(
      `INSERT INTO agent_policies (tenant_id, agent_key, mode, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, agent_key) DO UPDATE SET
         mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [scope.tenantId, agentKey, mode, scope.uid],
    );
    await audit(c, scope.tenantId, scope.uid, null, null, `policy:${agentKey}:${mode}`);
  });
}

// ---------------------------------------------------------------- propose
export interface ProposeInput {
  agentKey: string;
  kind: string;
  payload: Record<string, unknown>;
  /** Draft human-readable diff. Run through the figure firewall; on any
   *  violation the deterministic template replaces it. */
  summary?: string;
  /** Authoritative figures (cents / counts) the summary may quote. */
  figures?: (string | number)[];
  idempotencyKey: string;
  confidence?: number;
  runId?: string;
}

export interface ProposeResult {
  actionId: string;
  status: string;
  summary: string;
  /** True when the firewall replaced a drifting draft. */
  figureDrift: boolean;
  duplicate: boolean;
}

/**
 * The single doorway for agent mutations. Tenant comes from scope (never
 * the caller's payload); kind must exist in the closed registry AND belong
 * to the proposing agent; mode off blocks; ALWAYS_HITL kinds queue even in
 * auto; duplicates no-op via the idempotency key; the figure firewall is
 * terminal on the summary.
 */
export async function propose(
  scope: ActorScope,
  input: ProposeInput,
): Promise<ProposeResult> {
  if (!actionsEnabled()) throw new AgentError(409, "actions_disabled");
  if (!kindAllowed(input.kind)) throw new AgentError(422, "unknown_or_disallowed_kind");
  const spec = KINDS[input.kind]!;
  if (spec.owner !== input.agentKey) throw new AgentError(403, "kind_owner_mismatch");

  // The kind's own authz, checked on the PROPOSE path too — not just on the
  // human decision paths. In `auto` mode a non-alwaysHitl kind goes straight
  // to executeInTx below without ever passing a decide(), so the only authz
  // it saw was the run route's. Those two had already drifted: echo.write
  // declares roles owner/admin while POST /api/agents/echo/run admits all of
  // WRITE_ROLES, so a staff user could trigger execution of an owner-only
  // kind. Blast radius today is one events row; the pattern is the bug.
  checkScope(scope, scope.aal, spec.requires);

  return withTenant(scope, async (c) => {
    const mode = await getMode(c, scope.tenantId, input.agentKey);
    if (mode === "off") throw new AgentError(409, "agent_off");

    // Figure firewall: drafted summary must quote ONLY authoritative
    // figures; otherwise the deterministic template ships instead.
    const figures = input.figures ?? [];
    let summary = input.summary ?? spec.template(input.payload);
    let figureDrift = false;
    if (input.summary) {
      const check = verifyFigures(input.summary, figureUniverse(figures));
      if (!check.ok) {
        summary = spec.template(input.payload);
        figureDrift = true;
        await c.query(
          `INSERT INTO learning_events (tenant_id, agent_key, event, detail, actor)
           VALUES ($1,$2,'figure_drift',$3,$4)`,
          [
            scope.tenantId,
            input.agentKey,
            JSON.stringify({ violations: check.violations, draft: input.summary }),
            `agent:${input.agentKey}`,
          ],
        );
      }
    }

    const proposer = `agent:${input.agentKey}`;
    const ins = await c.query<{ id: string; status: string; summary: string }>(
      `INSERT INTO agent_actions
         (tenant_id, agent_key, kind, payload, summary, figures, confidence,
          run_id, idempotency_key, proposed_by, department_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id, status, summary`,
      [
        scope.tenantId,
        input.agentKey,
        input.kind,
        JSON.stringify(input.payload),
        summary,
        JSON.stringify(figures),
        input.confidence ?? null,
        input.runId ?? null,
        input.idempotencyKey,
        proposer,
        // Stamp the wall from the kind's own registry entry so the RESTRICTIVE
        // policy in 0029 knows what the TS layer knows. Single-valued: no kind
        // declares more than one department (registry.test.ts holds that).
        spec.requires.departments?.[0] ?? null,
      ],
    );

    if (ins.rows.length === 0) {
      const dup = await c.query<{ id: string; status: string; summary: string }>(
        `SELECT id, status, summary FROM agent_actions WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const d = dup.rows[0]!;
      return {
        actionId: d.id,
        status: d.status,
        summary: d.summary,
        figureDrift,
        duplicate: true,
      };
    }

    const action = ins.rows[0]!;
    await audit(c, scope.tenantId, proposer, action.id, null, "proposed", input.kind);

    // Auto mode executes immediately — unless the kind is ALWAYS_HITL
    // (money movement never auto-executes; high confidence lowers review
    // friction, it never removes the gate).
    if (mode === "auto" && !spec.alwaysHitl) {
      const result = await executeInTx(c, scope, action.id, "auto");
      return {
        actionId: action.id,
        status: result.status,
        summary: action.summary,
        figureDrift,
        duplicate: false,
      };
    }

    return {
      actionId: action.id,
      status: "proposed",
      summary: action.summary,
      figureDrift,
      duplicate: false,
    };
  });
}

// ---------------------------------------------------------------- execute
async function executeInTx(
  c: PoolClient,
  scope: TenantScope,
  actionId: string,
  executor: string,
): Promise<{ status: string; result?: unknown; error?: string }> {
  const { rows } = await c.query<{
    kind: string;
    payload: Record<string, unknown>;
    status: string;
    edit: Record<string, unknown> | null;
  }>(`SELECT kind, payload, status, edit FROM agent_actions WHERE id = $1 FOR UPDATE`, [
    actionId,
  ]);
  const a = rows[0];
  if (!a) throw new AgentError(404, "action_not_found");
  const spec = KINDS[a.kind];
  if (!spec) throw new AgentError(422, "unknown_or_disallowed_kind");
  // The master kill switch and the per-kind allowlist were checked only in
  // propose(). That left ALREADY-QUEUED actions executable after the switch
  // was thrown — exactly the moment you most want everything to stop.
  if (!actionsEnabled() || !kindAllowed(a.kind)) {
    throw new AgentError(403, "actions_disabled");
  }

  const payload = { ...a.payload, ...(a.edit ?? {}) };
  // SAVEPOINT: a failing executor must abort ONLY its own writes — the
  // action row, failed-status update, and audit trail survive. (Without
  // this, any DB error poisons the whole transaction: 25P02.)
  await c.query("SAVEPOINT agent_exec");
  try {
    const result = await spec.execute({ scope, client: c, actionId }, payload);
    await c.query("RELEASE SAVEPOINT agent_exec");
    await c.query(
      `UPDATE agent_actions SET status = 'executed', executed_at = now(), result = $2
        WHERE id = $1`,
      [actionId, JSON.stringify(result ?? null)],
    );
    await audit(c, scope.tenantId, executor, actionId, a.status, "executed");
    return { status: "executed", result };
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT agent_exec");
    // The RAW message is server-side only: Postgres errors carry constraint
    // names, column names and "permission denied for table ..." — a schema map
    // for anyone who can force a failure. agent_actions.error is read back by
    // every tenant member via /api/agents/overview, so it stores a stable code
    // instead, and the detail goes to the audit trail.
    const raw = err instanceof Error ? err.message : String(err);
    const code = err instanceof HttpError ? err.code : "executor_failed";
    console.error("[agent-exec] %s failed", a.kind, { actionId, raw });
    await c.query(
      `UPDATE agent_actions SET status = 'failed', error = $2 WHERE id = $1`,
      [actionId, code],
    );
    await audit(c, scope.tenantId, executor, actionId, a.status, "failed", raw);
    return { status: "failed", error: code };
  }
}

// ----------------------------------------------------------------- decide
export type Decision =
  | { type: "approve" }
  | { type: "revise"; edit: Record<string, unknown> }
  | { type: "reject"; reason?: string };

/**
 * The human side of the gate. maker != checker is enforced by a DB CHECK;
 * every decision is a learning signal (approve -> positive case, revise ->
 * CIPHER preference candidate, reject -> negative case + reflection).
 */
export async function decide(
  scope: TenantScope,
  actionId: string,
  decision: Decision,
  /** The approver's assurance level — required to enforce a kind's authz. */
  aal: "aal1" | "aal2" = "aal1",
): Promise<{ status: string; error?: string }> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      id: string;
      status: string;
      agent_key: string;
      kind: string;
      payload: Record<string, unknown>;
      proposed_by: string;
    }>(`SELECT id, status, agent_key, kind, payload, proposed_by
          FROM agent_actions WHERE id = $1 FOR UPDATE`, [actionId]);
    const a = rows[0];
    if (!a) throw new AgentError(404, "action_not_found");
    if (a.status !== "proposed") throw new AgentError(409, "already_decided");

    // The approver must hold what the equivalent REST route demands. Without
    // this the gate WAS the privilege escalation: a viewer could approve a
    // bank.categorize card and post to the general ledger, while /api/bank/
    // txns/[id]/resolve refused them 403. Checked before reject too — deciding
    // another department's money card is not a viewer's call either way.
    const spec = KINDS[a.kind];
    if (!spec) throw new AgentError(422, "unknown_or_disallowed_kind");
    checkScope(scope as Parameters<typeof checkScope>[0], aal, spec.requires);

    /**
     * ⛔ A revision may only touch the fields the KIND says are revisable.
     *
     * `executeInTx` merges `edit` over the payload and runs the result, and
     * `edit` arrives as an open record from the client. Unconstrained, an
     * approver can rewrite the ids that decide WHICH invoice gets chased or
     * WHICH transaction gets categorised — while `agent_actions.payload`, the
     * column a reviewer reads, still names the original. The action that ran
     * and the action on file stop being the same thing.
     *
     * Closed by default: a kind with no `editable` list accepts no edits, so
     * adding a kind cannot accidentally open this. Fail-closed, and the error
     * names the offending field so an operator can see why.
     */
    if (decision.type === "revise") {
      const allowed = new Set(spec.editable ?? []);
      const rejected = Object.keys(decision.edit).filter((k) => !allowed.has(k));
      if (rejected.length > 0) {
        throw new AgentError(422, `field_not_revisable:${rejected.sort().join(",")}`);
      }
      if (Object.keys(decision.edit).length === 0) {
        // An empty edit is an approve wearing a revise's clothes, and it would
        // be recorded as a CIPHER preference candidate learned from nothing.
        throw new AgentError(422, "empty_revision");
      }
    }

    if (decision.type === "reject") {
      await c.query(
        `UPDATE agent_actions SET status = 'rejected', decided_by = $2, decided_at = now()
          WHERE id = $1`,
        [actionId, scope.uid],
      );
      await audit(c, scope.tenantId, scope.uid, actionId, "proposed", "rejected", decision.reason);
      await recordDecisionCase(c, scope, a.agent_key, actionId, a.payload, "rejected", null, decision.reason);
      return { status: "rejected" };
    }

    const edit = decision.type === "revise" ? decision.edit : null;
    await c.query(
      `UPDATE agent_actions SET status = 'approved', decided_by = $2, decided_at = now(),
              edit = $3
        WHERE id = $1`,
      [actionId, scope.uid, edit ? JSON.stringify(edit) : null],
    );
    await audit(
      c,
      scope.tenantId,
      scope.uid,
      actionId,
      "proposed",
      "approved",
      edit ? "revised" : undefined,
    );
    await recordDecisionCase(
      c,
      scope,
      a.agent_key,
      actionId,
      a.payload,
      edit ? "edited" : "accepted",
      edit,
    );
    return executeInTx(c, scope, actionId, scope.uid);
  });
}

// ------------------------------------------------------------------- undo
export async function undoAction(
  scope: TenantScope,
  actionId: string,
  /** Undo reverses a ledger write — same authz bar as approving it. */
  aal: "aal1" | "aal2" = "aal1",
): Promise<{ status: string }> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      kind: string;
      payload: Record<string, unknown>;
      status: string;
      agent_key: string;
      edit: Record<string, unknown> | null;
    }>(`SELECT kind, payload, status, agent_key, edit
          FROM agent_actions WHERE id = $1 FOR UPDATE`, [actionId]);
    const a = rows[0];
    if (!a) throw new AgentError(404, "action_not_found");
    if (a.status !== "executed") throw new AgentError(409, "not_executed");
    const spec = KINDS[a.kind];
    if (!spec?.undo) throw new AgentError(422, "not_undoable");
    // Reversing a posted entry is as sensitive as posting it.
    checkScope(scope as Parameters<typeof checkScope>[0], aal, spec.requires);

    await spec.undo({ scope, client: c, actionId }, { ...a.payload, ...(a.edit ?? {}) });
    await c.query(`UPDATE agent_actions SET status = 'undone' WHERE id = $1`, [actionId]);
    await audit(c, scope.tenantId, scope.uid, actionId, "executed", "undone");
    await recordDecisionCase(c, scope, a.agent_key, actionId, a.payload, "undone", null);
    return { status: "undone" };
  });
}

// ------------------------------------------------------------------ reads
export interface ActionRow {
  id: string;
  agentKey: string;
  kind: string;
  status: string;
  summary: string;
  payload: Record<string, unknown>;
  confidence: number | null;
  proposedBy: string;
  decidedBy: string | null;
  error: string | null;
  createdAt: string;
}

export async function listActions(
  scope: ActorScope,
  status?: string,
): Promise<ActionRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT id, agent_key AS "agentKey", kind, status, summary, payload,
              confidence, proposed_by AS "proposedBy", decided_by AS "decidedBy",
              error, created_at::text AS "createdAt"
         FROM agent_actions
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY created_at DESC LIMIT 200`,
      [status ?? null],
    );
    const check = readerCheck(scope);
    return (rows as ActionRow[]).filter((r) => canSeeKind(check, r.kind));
  });
}

export async function listPolicies(
  scope: TenantScope,
): Promise<{ agentKey: string; mode: AgentMode }[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ agent_key: string; mode: AgentMode }>(
      `SELECT agent_key, mode FROM agent_policies`,
    );
    const set = new Map(rows.map((r) => [r.agent_key, r.mode]));
    // Derived from the registry, not re-listed here: a hand-copied list shipped
    // the sales agent permanently OFF with no UI row to turn it on — the drift
    // class this line now makes unrepresentable.
    return AGENT_KEYS.map((k) => ({
      agentKey: k,
      mode: set.get(k) ?? "off",
    }));
  });
}
