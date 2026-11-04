-- 0012: the automation/agent framework (ported from the ServiceTitan Agent
-- Platform ADRs 0003/0007/0008 — the action gate, run loop, dead-letter,
-- cost caps, and the self-learning core).
--
-- Automation-first: department "employees" are deterministic automations;
-- an LLM is a bounded helper that NEVER computes a figure and never drives
-- control flow. Every agent state change flows through the action gate
-- (propose -> approve/revise/reject -> execute -> undo) and every human
-- decision is a learning signal.

-- Per-tenant, per-agent mode. Default OFF — an agent does nothing until a
-- human turns it on.
CREATE TABLE agent_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_key text NOT NULL,
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'approve', 'auto')),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_key)
);

-- The gate. One row per proposed mutation; the human-readable summary IS
-- the diff being approved. figures = the authoritative numbers the summary
-- may quote (the firewall enforces verbatim match).
CREATE TABLE agent_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_key text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN
    ('proposed', 'approved', 'rejected', 'executed', 'failed', 'undone')),
  payload jsonb NOT NULL,
  summary text NOT NULL,
  figures jsonb NOT NULL DEFAULT '[]',
  confidence int,
  run_id uuid,
  idempotency_key text NOT NULL,
  proposed_by text NOT NULL,
  decided_by text,
  decided_at timestamptz,
  edit jsonb,
  executed_at timestamptz,
  result jsonb,
  error text,
  undo_of uuid REFERENCES agent_actions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  -- maker != checker, enforced at the database.
  CHECK (decided_by IS NULL OR decided_by <> proposed_by)
);
CREATE INDEX agent_actions_queue ON agent_actions (tenant_id, status, created_at);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_key text NOT NULL,
  trigger text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN
    ('running', 'ok', 'error', 'dead_letter')),
  attempt int NOT NULL DEFAULT 1,
  input jsonb,
  output jsonb,
  error text,
  cost_microusd bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- 5 failed attempts -> dead letter + the agent flips OFF + an assessment
-- card a human can read (deterministic template).
CREATE TABLE agent_dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_key text NOT NULL,
  run_id uuid,
  reason text NOT NULL,
  assessment text NOT NULL,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- DB-backed cost caps (per-tenant per-day; a global cap sums this table).
CREATE TABLE agent_daily_costs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  day date NOT NULL,
  cost_microusd bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

-- Every gate transition, auditable forever (append-only).
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor text NOT NULL,
  action_id uuid,
  from_status text,
  to_status text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ learning
-- CBR case bank: every human decision recorded (approve/edit/reject/undo).
CREATE TABLE agent_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_key text NOT NULL,
  action_id uuid REFERENCES agent_actions(id),
  situation jsonb NOT NULL,
  proposal jsonb NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted', 'edited', 'rejected', 'undone')),
  edit jsonb,
  reflection text,
  effectiveness int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_cases_retrieve ON agent_cases (tenant_id, agent_key, created_at DESC);

-- CIPHER preferences distilled from substantial human edits. Quarantined
-- until a distinct-approver quorum activates them; one-click demotable.
CREATE TABLE agent_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_key text NOT NULL,
  rule text NOT NULL,
  source_case_id uuid REFERENCES agent_cases(id),
  status text NOT NULL DEFAULT 'quarantined'
    CHECK (status IN ('quarantined', 'active', 'demoted')),
  approvers text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);

-- Append-only learning audit (what was learned, from whom, when).
CREATE TABLE learning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_key text NOT NULL,
  event text NOT NULL,
  detail jsonb,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agent_policies', 'agent_actions', 'agent_runs', 'agent_dead_letters',
    'agent_daily_costs', 'audit_events', 'agent_cases', 'agent_preferences',
    'learning_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON agent_policies, agent_actions, agent_runs,
  agent_dead_letters, agent_daily_costs, agent_preferences TO app_user;
-- Append-only surfaces: no UPDATE grant at all.
GRANT SELECT, INSERT ON audit_events, agent_cases, learning_events TO app_user;

-- Immutability triggers on the audit trails (hold even for superuser).
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();
CREATE TRIGGER learning_events_immutable
  BEFORE UPDATE OR DELETE ON learning_events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();
