-- 0023: subscription billing (the SaaS side — NOT customer invoices).
--
-- Two flat plans, no per-head pricing: Crew ($349/mo, up to 10 people) and
-- Shop ($499/mo, up to 25). One row per tenant, FORCE-RLS like everything
-- else, so a tenant can never read another tenant's billing state. The
-- Stripe ids live here and NOWHERE else; the webhook resolves the tenant by
-- stripe_customer_id from THIS table — never from a payload-supplied id.

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan text NOT NULL DEFAULT 'crew' CHECK (plan IN ('crew', 'shop')),
  seat_cap int NOT NULL DEFAULT 10 CHECK (seat_cap > 0),
  status text NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id),
  UNIQUE (stripe_customer_id),
  UNIQUE (stripe_subscription_id)
);

-- Webhook idempotency: a replayed Stripe event is a no-op, forever.
CREATE TABLE billing_events (
  event_id text PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriptions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON subscriptions TO app_user;

-- billing_events is operator plumbing (no tenant scope on read by design:
-- it holds no tenant data beyond a fk), so it is NOT granted to app_user.
-- The webhook path uses the privileged pool, like the LIR aggregate.

-- Resolve a tenant from a Stripe customer id WITHOUT a session (the webhook
-- arrives with no user). SECURITY DEFINER, returns the tenant id or nothing.
CREATE OR REPLACE FUNCTION app.tenant_by_stripe_customer(p_customer text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, app
AS $$ SELECT tenant_id FROM subscriptions WHERE stripe_customer_id = p_customer $$;
REVOKE ALL ON FUNCTION app.tenant_by_stripe_customer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_by_stripe_customer(text) TO app_user;

-- Every existing tenant starts on a 30-day Crew trial (matches the offer's
-- 30-day money-back promise; new tenants get theirs at signup).
INSERT INTO subscriptions (tenant_id, plan, seat_cap, status, trial_ends_at)
SELECT id, 'crew', 10, 'trialing', now() + interval '30 days' FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- --------------------------------------------------------------- deletion
-- Posted time entries are immutable — but a tenant deleting its own books
-- must be able to take them too. Same hatch the ledger uses.
CREATE OR REPLACE FUNCTION app.forbid_posted_time_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(current_setting('app.ledger_purge', true), '') = 'on' THEN
      RETURN OLD; -- deliberate tenant purge in progress
    END IF;
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'posted time entries are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'posted time entries are immutable';
  END IF;
  RETURN NEW;
END $$;

-- "Delete my account", done safely. SECURITY DEFINER (the app role has no
-- DELETE grant on the append-only money tables, and MUST NOT get one), but
-- it takes NO tenant argument: it purges ONLY the tenant already in the
-- session GUC, which our authenticated scope set. So a caller can never
-- name someone else's tenant, and an unscoped session deletes nothing.
CREATE OR REPLACE FUNCTION app.purge_current_tenant()
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.current_tenant', true), '')::uuid;
  v_table text;
  v_deleted bigint := 0;
  v_count bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant in scope — refusing to purge';
  END IF;
  PERFORM set_config('app.ledger_purge', 'on', true);
  FOR v_table IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  LOOP
    -- Children before parents: repeat until the graph settles (FKs make a
    -- single pass insufficient, and this is small, one-tenant data).
    BEGIN
      EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_table) USING v_tenant;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      v_deleted := v_deleted + v_count;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL; -- retried in the second pass below
    END;
  END LOOP;
  FOR v_table IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  LOOP
    EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_table) USING v_tenant;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_deleted := v_deleted + v_count;
  END LOOP;
  DELETE FROM tenants WHERE id = v_tenant;
  RETURN v_deleted;
END $$;
REVOKE ALL ON FUNCTION app.purge_current_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_current_tenant() TO app_user;
