-- The daily cron's tenant enumeration.
--
-- Caught live on the first production firing: the cron did
-- `SELECT id, name FROM tenants` on the raw pool and got ZERO rows — the
-- member-read policy on tenants keys on app.current_uid, and a machine
-- principal has no uid. Correct behavior by the isolation model; wrong tool
-- for the job. (Fourth appearance of the unset-scope-reads-empty law this
-- build; this time the law was doing exactly what it should.)
--
-- The fix is an EXPLICIT, named grant of exactly what the heartbeat needs:
-- ids and display names, nothing else. SECURITY DEFINER like the other
-- narrow platform functions (tenant_by_stripe_customer, portal_context),
-- search_path pinned, PUBLIC revoked.

CREATE OR REPLACE FUNCTION app.cron_tenants()
RETURNS TABLE (id uuid, name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS $$
  SELECT t.id, t.name FROM tenants t ORDER BY t.created_at
$$;

REVOKE ALL ON FUNCTION app.cron_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cron_tenants() TO app_user;

COMMENT ON FUNCTION app.cron_tenants() IS
  'Tenant enumeration for the daily heartbeat (/api/cron/daily). Ids and '
  'names only. The cron then scopes per tenant with withTenant, so every '
  'downstream read still runs under that tenant''s RLS.';
