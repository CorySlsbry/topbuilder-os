-- Portal tokens expire, and stop being permanent bearer credentials.
--
-- app.portal_context() validated only `NOT revoked` — there was no expiry and
-- no rotation, and the token IS the URL path segment (/portal/<uuid>). So it
-- lands in Cloud Run and load-balancer access logs, in the customer's browser
-- history, in any screenshot they share, and — because it was passed straight
-- through as Stripe's success_url/cancel_url — in the Stripe dashboard too.
--
-- Anyone who later reads any of those places could open that customer's whole
-- job, invoice and estimate history, and APPROVE AN ESTIMATE, which sets a
-- binding contract value. Forever. The customer had no way to revoke it.
--
-- 60 days: long enough to cover a re-roof from proposal to final invoice
-- without a dead link mid-job, short enough that a leaked URL stops working
-- within a season. Existing tokens get the same window from now rather than
-- being killed outright — nobody's live job breaks because we shipped a fix.

ALTER TABLE portal_tokens
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE portal_tokens SET expires_at = now() + interval '60 days'
 WHERE expires_at IS NULL;

ALTER TABLE portal_tokens
  ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '60 days');

-- The expiry has to be enforced HERE, in the SECURITY DEFINER function that
-- mints the tenant scope, not in application code. This function is the trust
-- boundary: everything downstream runs with the tenant scope it returns.
--
-- Signature preserved EXACTLY as migration 0019 left it — it returns a third
-- column (tenant_name) that 0018 did not, and rewriting from 0018's shape
-- would have silently dropped the shop's name from every portal page. Only
-- the WHERE clause changes here.
CREATE OR REPLACE FUNCTION app.portal_context(p_token uuid)
RETURNS TABLE (tenant_id uuid, customer_id uuid, tenant_name text)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, app
AS $$
  SELECT pt.tenant_id, pt.customer_id, t.name
    FROM portal_tokens pt JOIN tenants t ON t.id = pt.tenant_id
   WHERE pt.token = p_token
     AND NOT pt.revoked
     AND pt.expires_at > now()
$$;
REVOKE ALL ON FUNCTION app.portal_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.portal_context(uuid) TO app_user;

CREATE INDEX IF NOT EXISTS portal_tokens_expiry_idx
  ON portal_tokens (tenant_id, expires_at) WHERE NOT revoked;

COMMENT ON COLUMN portal_tokens.expires_at IS
  'Hard expiry enforced inside app.portal_context(). The token travels in a '
  'URL path segment, so it is logged in several places outside our control — '
  'it must age out on its own.';
