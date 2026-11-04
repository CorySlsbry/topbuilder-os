-- 0019: the portal greets with the business name.
-- portal_context also returns the tenant's display name — still nothing a
-- token holder shouldn't see (it's on the truck and the invoice).
DROP FUNCTION app.portal_context(uuid);
CREATE FUNCTION app.portal_context(p_token uuid)
RETURNS TABLE (tenant_id uuid, customer_id uuid, tenant_name text)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, app
AS $$
  SELECT pt.tenant_id, pt.customer_id, t.name
    FROM portal_tokens pt JOIN tenants t ON t.id = pt.tenant_id
   WHERE pt.token = p_token AND NOT pt.revoked
$$;
REVOKE ALL ON FUNCTION app.portal_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.portal_context(uuid) TO app_user;
