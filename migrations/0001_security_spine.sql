-- 0001_security_spine — three-level isolation: tenant + department + role.
--
-- Runs as the migration superuser/owner. Tables are owned by that role; the
-- app connects as the NON-superuser `app_user` (no BYPASSRLS) so it can never
-- bypass RLS. Directory tables (tenants, memberships) are ENABLE-only NO FORCE
-- so tenancy resolves BEFORE a tenant GUC exists; sensitive tenant tables are
-- ENABLE + FORCE, fail-closed (unset scope => zero rows).

-- ========================================================= helper schema + GUCs
CREATE SCHEMA IF NOT EXISTS app;

-- Per-request principal (Identity Platform uid). Set by the server from the
-- verified session — NEVER from a client-supplied claim.
CREATE OR REPLACE FUNCTION app.current_uid() RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_uid', true), '')
$$;

-- Active tenant. NULL when unset => policies compare against NULL => zero rows.
CREATE OR REPLACE FUNCTION app.current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
$$;

-- Department keys the principal may see in the active tenant (CSV -> array).
CREATE OR REPLACE FUNCTION app.current_departments() RETURNS text[]
  LANGUAGE sql STABLE AS $$
  SELECT string_to_array(
           NULLIF(current_setting('app.current_departments', true), ''), ','
         )
$$;

-- True iff the principal may see rows tagged to department key `dept`.
CREATE OR REPLACE FUNCTION app.can_see_department(dept text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT dept = ANY (COALESCE(app.current_departments(), ARRAY[]::text[]))
$$;

GRANT USAGE ON SCHEMA app TO app_user;

-- ========================================================= directory tables
-- ENABLE-only, NO FORCE.
CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    text NOT NULL,                         -- Identity Platform uid
  role       text NOT NULL
             CHECK (role IN ('owner','admin','staff','bookkeeper','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx   ON memberships(user_id);
CREATE INDEX memberships_tenant_idx ON memberships(tenant_id);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

-- You can always read your OWN memberships (resolves tenancy pre-GUC)...
CREATE POLICY memberships_self_read ON memberships FOR SELECT
  USING (user_id = app.current_uid());
-- ...and co-members within your active tenant (team management screens).
CREATE POLICY memberships_tenant_read ON memberships FOR SELECT
  USING (tenant_id = app.current_tenant());

-- You see the tenants you belong to.
CREATE POLICY tenants_member_read ON tenants FOR SELECT
  USING (id IN (SELECT m.tenant_id FROM memberships m
                WHERE m.user_id = app.current_uid()));

-- ========================================================= tenant tables (FORCE)
CREATE TABLE departments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        text NOT NULL,      -- 'field-ops','financials','hr-payroll','dispatch'
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments FORCE  ROW LEVEL SECURITY;
CREATE POLICY departments_tenant_isolation ON departments
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

CREATE TABLE member_department_access (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_id, department_id)
);
ALTER TABLE member_department_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_department_access FORCE  ROW LEVEL SECURITY;
CREATE POLICY mda_tenant_isolation ON member_department_access
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- LIR (leading-indicator-of-retention) product events.
CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  subject_type text,
  subject_id   uuid,
  actor_uid    text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_tenant_name_idx ON events(tenant_id, name, occurred_at);
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE  ROW LEVEL SECURITY;
CREATE POLICY events_tenant_isolation ON events
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- ========================================================= signup bootstrap
-- Creates a tenant + its owner membership atomically. SECURITY DEFINER because
-- at signup there is no prior membership to authorize against. The ONLY way
-- app_user creates a tenant. Sets the tenant GUC before touching FORCE tables
-- so it works even where the owner role is not a true superuser (Cloud SQL).
CREATE OR REPLACE FUNCTION app.provision_tenant(
  p_name text, p_slug text, p_owner_uid text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid;
BEGIN
  IF p_owner_uid IS NULL OR p_owner_uid = '' THEN
    RAISE EXCEPTION 'owner uid required';
  END IF;
  INSERT INTO tenants(name, slug) VALUES (p_name, p_slug) RETURNING id INTO v_tenant;
  INSERT INTO memberships(tenant_id, user_id, role)
    VALUES (v_tenant, p_owner_uid, 'owner');
  PERFORM set_config('app.current_tenant', v_tenant::text, true);
  INSERT INTO events(tenant_id, name, actor_uid)
    VALUES (v_tenant, 'tenant_provisioned', p_owner_uid);
  RETURN v_tenant;
END
$$;

-- ========================================================= grants (app_user)
-- Read the directory + tenant tables (RLS-scoped); emit LIR events; call the
-- helper + signup functions. NO direct writes to tenants/memberships/
-- departments (those go through vetted functions / role-gated app paths).
GRANT SELECT ON tenants, memberships, departments, member_department_access, events TO app_user;
GRANT INSERT ON events TO app_user;
GRANT EXECUTE ON FUNCTION
  app.current_uid(),
  app.current_tenant(),
  app.current_departments(),
  app.can_see_department(text),
  app.provision_tenant(text, text, text)
TO app_user;
