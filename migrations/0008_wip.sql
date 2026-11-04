-- 0008_wip — WIP snapshots (immutable) + lean purchase orders (committed costs).
--
-- wip_snapshots is the CPA artifact: a point-in-time, never-edited record of
-- each job's percentage-of-completion math. Same two-layer append-only defense
-- as the journal. purchase_orders here is the minimal committed-cost source
-- (open POs + expected sub invoices); S12 (purchasing/AP) deepens it with
-- vendors, bills, and receiving.

CREATE TABLE purchase_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id      uuid NOT NULL,
  kind        text NOT NULL DEFAULT 'po' CHECK (kind IN ('po','sub')),
  vendor_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','received','canceled')),
  created_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id)
);
CREATE INDEX po_tenant_job_idx ON purchase_orders(tenant_id, job_id, status);
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE  ROW LEVEL SECURITY;
CREATE POLICY po_tenant ON purchase_orders
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

CREATE TABLE wip_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id       uuid NOT NULL,
  as_of        date NOT NULL,
  contract_cents      bigint NOT NULL CHECK (contract_cents >= 0),
  costs_to_date_cents bigint NOT NULL CHECK (costs_to_date_cents >= 0),
  etc_cents           bigint NOT NULL CHECK (etc_cents >= 0),
  committed_cents     bigint NOT NULL DEFAULT 0 CHECK (committed_cents >= 0),
  pct_complete_bps    int    NOT NULL CHECK (pct_complete_bps BETWEEN 0 AND 10000),
  earned_cents        bigint NOT NULL CHECK (earned_cents >= 0),
  billed_cents        bigint NOT NULL CHECK (billed_cents >= 0),
  underbilled_cents   bigint NOT NULL CHECK (underbilled_cents >= 0),
  overbilled_cents    bigint NOT NULL CHECK (overbilled_cents >= 0),
  created_by   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, job_id, as_of),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id)
);
CREATE INDEX wip_tenant_asof_idx ON wip_snapshots(tenant_id, as_of);
ALTER TABLE wip_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE wip_snapshots FORCE  ROW LEVEL SECURITY;
CREATE POLICY wip_tenant ON wip_snapshots
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
CREATE TRIGGER wip_snapshots_immutable
  BEFORE UPDATE OR DELETE ON wip_snapshots
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();

-- grants
GRANT SELECT, INSERT, UPDATE ON purchase_orders TO app_user; -- status transitions
GRANT SELECT, INSERT         ON wip_snapshots  TO app_user;  -- append-only
