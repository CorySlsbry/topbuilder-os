-- 0011: QBO bridge — migration-in, export, and the optional Accountant Sync.
--
-- WE are the book of record; QBO is a peripheral. Three uses:
--   1. migration-in (pull a switching tenant's books out of QBO),
--   2. export forever (IIF / QBO-journal CSV — reversibility kills lock-in),
--   3. Accountant Sync (optional one-way push of OUR ledger into the CPA's
--      QBO file; our GL is authoritative, the QBO copy is derived).
-- Tokens are encrypted at rest (AES-256-GCM locally; Cloud KMS envelope when
-- GCP lands) and are never returned by any API.

CREATE TABLE qbo_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  realm_id text NOT NULL,
  environment text NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production')),
  access_token_enc text NOT NULL,
  refresh_token_enc text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'healthy'
    CHECK (status IN ('healthy', 'error', 'disconnected')),
  last_error text,
  sync_enabled boolean NOT NULL DEFAULT false,
  connected_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- Local entity <-> QBO entity id map (idempotent import AND sync).
CREATE TABLE qbo_entity_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  local_type text NOT NULL,
  local_id text NOT NULL,
  qbo_type text NOT NULL,
  qbo_id text NOT NULL,
  qbo_sync_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, local_type, local_id),
  UNIQUE (tenant_id, qbo_type, qbo_id)
);

CREATE TABLE qbo_sync_state (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  -- Journal entries created after this instant still need pushing.
  cursor timestamptz NOT NULL DEFAULT 'epoch',
  last_pushed_at timestamptz,
  pushed_count bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'error')),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE qbo_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE qbo_entity_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_entity_map FORCE ROW LEVEL SECURITY;
ALTER TABLE qbo_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_sync_state FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON qbo_connections
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON qbo_entity_map
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON qbo_sync_state
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON qbo_connections TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON qbo_entity_map TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON qbo_sync_state TO app_user;
