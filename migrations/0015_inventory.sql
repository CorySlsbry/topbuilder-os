-- 0015: inventory/materials — stock on hand, receipts, issues to jobs.
--
-- Book = shelf, always: every move that changes stock value posts to the
-- GL in the same transaction (receipt: DR 1310 inventory / CR 2110 AP via
-- a vendor bill; issue: DR 1430 job cost with dims / CR 1310 at the moving
-- average; count adjustment: 3830 vs 1310). inventory_moves is the
-- append-only stock ledger; qty_on_hand is its maintained rollup.

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'ea',
  -- quantities in hundredths (2.5 boxes -> 250) — integers only, like hours
  qty_on_hand_x100 bigint NOT NULL DEFAULT 0,
  -- moving-average unit cost, cents
  avg_unit_cost_cents bigint NOT NULL DEFAULT 0 CHECK (avg_unit_cost_cents >= 0),
  reorder_point_x100 bigint NOT NULL DEFAULT 0,
  reorder_qty_x100 bigint NOT NULL DEFAULT 0,
  preferred_vendor text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id),
  -- Negative stock is a data bug, not a feature: an issue larger than
  -- what's on the shelf is refused at the database.
  CHECK (qty_on_hand_x100 >= 0)
);

CREATE TABLE inventory_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  item_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receipt', 'issue', 'adjust')),
  -- signed: receipts positive, issues negative, adjusts either
  qty_x100 bigint NOT NULL CHECK (qty_x100 <> 0),
  unit_cost_cents bigint NOT NULL CHECK (unit_cost_cents >= 0),
  job_id uuid,
  po_id uuid,
  bill_id uuid,
  journal_entry_id uuid,
  memo text NOT NULL DEFAULT '',
  occurred_on date NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id)
);

-- Stock reorder POs have no job: relax the S6 NOT NULL. Job-scoped
-- committed-cost queries join through jobs and are unaffected.
ALTER TABLE purchase_orders ALTER COLUMN job_id DROP NOT NULL;

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_moves FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_items
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON inventory_moves
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON inventory_items TO app_user;
-- The stock ledger is append-only at BOTH layers.
GRANT SELECT, INSERT ON inventory_moves TO app_user;
CREATE TRIGGER inventory_moves_immutable
  BEFORE UPDATE OR DELETE ON inventory_moves
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();
