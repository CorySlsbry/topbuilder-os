-- 0018: customer portal + CRM + reviews.
--
-- The portal is a per-customer signed door: a revocable token resolves
-- (tenant, customer) via SECURITY DEFINER; everything else runs under
-- normal RLS with that tenant scope. Customers see THEIR jobs, invoices,
-- and estimates — and can approve an estimate from the couch.

CREATE TABLE portal_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL,
  token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  revoked boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);

CREATE TABLE review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  job_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'sent', 'done', 'skipped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, job_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id)
);

-- Where happy customers land (Google review link etc.) — tenant setting.
ALTER TABLE tenants ADD COLUMN review_url text NOT NULL DEFAULT '';

ALTER TABLE portal_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE review_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_tokens
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON review_requests
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON portal_tokens, review_requests TO app_user;

-- Resolve a portal token WITHOUT a session: (tenant, customer) or nothing.
-- Revoked tokens resolve to nothing. SECURITY DEFINER, minimal columns.
CREATE OR REPLACE FUNCTION app.portal_context(p_token uuid)
RETURNS TABLE (tenant_id uuid, customer_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, app
AS $$
  SELECT tenant_id, customer_id FROM portal_tokens
   WHERE token = p_token AND NOT revoked
$$;
REVOKE ALL ON FUNCTION app.portal_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.portal_context(uuid) TO app_user;
