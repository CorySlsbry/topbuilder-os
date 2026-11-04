-- Fix the webhook path (found live 2026-07-24, first real Stripe event).
--
-- 0023 left billing_events with NO grant and NO RLS, on the theory that the
-- webhook ran on a privileged pool. It doesn't — there is no privileged pool;
-- getPool() connects as app_user. So EVERY webhook 500'd with 42501
-- "permission denied for table billing_events", which means no subscription
-- would ever have synced from Stripe. The comment described an architecture
-- that was never built.
--
-- The fix is better than the original plan: the webhook resolves the tenant
-- through app.tenant_by_stripe_customer() (SECURITY DEFINER, so it works with
-- no session), and then does all its work INSIDE that tenant's scope. RLS
-- therefore applies to the webhook exactly as it does to a user request, and a
-- webhook physically cannot write another tenant's row — a stronger guarantee
-- than a privileged pool, which would have bypassed policies entirely.

-- Every event we store is resolved to a tenant before insert; a NULL tenant
-- would be a row no policy can see.
DELETE FROM billing_events WHERE tenant_id IS NULL;
ALTER TABLE billing_events ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON billing_events
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- SELECT for the replay/dedupe check, INSERT to record the event. No UPDATE
-- and no DELETE: the event log is append-only like the rest of the money
-- plane, and the account purge reaches it via app.purge_current_tenant().
GRANT SELECT, INSERT ON billing_events TO app_user;
