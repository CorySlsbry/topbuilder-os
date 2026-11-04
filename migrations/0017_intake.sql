-- 0017: call intake + booking.
--
-- Every inbound request (voice webhook, website form, manual entry) lands
-- in intake_requests, idempotent per external id (Retell call_id, form
-- nonce). The Receptionist agent books real open slots only; booking is
-- undoable (cancel the appointment, the request returns to 'new').

CREATE TABLE intake_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source text NOT NULL DEFAULT 'web' CHECK (source IN ('call', 'web', 'manual')),
  -- Retell call_id / form nonce — the idempotency key for the channel.
  external_id text NOT NULL,
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  preferred_window text NOT NULL DEFAULT 'any'
    CHECK (preferred_window IN ('any', 'morning', 'afternoon')),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'booked', 'declined', 'spam')),
  customer_id uuid,
  job_id uuid,
  appointment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX intake_queue ON intake_requests (tenant_id, status, created_at);

ALTER TABLE intake_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON intake_requests
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON intake_requests TO app_user;

-- Public booking pages resolve a tenant from its slug WITHOUT a session.
-- SECURITY DEFINER returning ONLY the id — the slug is already public in
-- the tenant's own booking URL; no other tenant data is reachable.
CREATE OR REPLACE FUNCTION app.tenant_id_by_slug(p_slug text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, app
AS $$ SELECT id FROM tenants WHERE slug = p_slug $$;
REVOKE ALL ON FUNCTION app.tenant_id_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_id_by_slug(text) TO app_user;
