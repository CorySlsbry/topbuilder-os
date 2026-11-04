-- 0006_revenue — the revenue engine: pricebook, good-better-best estimates,
-- invoices (tax + retainage aware), and the append-only payments ledger.
-- Every money event posts to the GL through the ledger port; invoices carry
-- the full split (subtotal / tax / retainage) so AR is never silently wrong.

CREATE TABLE pricebook_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  description     text,
  unit            text NOT NULL DEFAULT 'each',   -- each | square | hour | lf | sf
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  unit_cost_cents  bigint CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  trade           text,                            -- roofing | solar | hvac | ...
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
ALTER TABLE pricebook_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricebook_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY pb_tenant ON pricebook_items
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

CREATE TABLE estimates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id      uuid NOT NULL,
  status      text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','sent','approved','declined')),
  approved_option_id uuid,
  created_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id)
);
ALTER TABLE estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimates FORCE  ROW LEVEL SECURITY;
CREATE POLICY est_tenant ON estimates
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

-- Good-better-best: each estimate holds up to three tiered options.
CREATE TABLE estimate_options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  estimate_id uuid NOT NULL,
  tier        text NOT NULL CHECK (tier IN ('good','better','best')),
  title       text NOT NULL,
  summary     text,
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  UNIQUE (estimate_id, tier),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, estimate_id) REFERENCES estimates(tenant_id, id)
);
ALTER TABLE estimate_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimate_options FORCE  ROW LEVEL SECURITY;
CREATE POLICY esto_tenant ON estimate_options
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

CREATE TABLE estimate_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  option_id    uuid NOT NULL,
  pricebook_item_id uuid,
  description  text NOT NULL,
  qty_x100     bigint NOT NULL CHECK (qty_x100 > 0),        -- 2.5 units → 250
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents bigint NOT NULL CHECK (line_total_cents >= 0),
  line_no      int NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, option_id) REFERENCES estimate_options(tenant_id, id),
  FOREIGN KEY (tenant_id, pricebook_item_id) REFERENCES pricebook_items(tenant_id, id)
);
ALTER TABLE estimate_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimate_lines FORCE  ROW LEVEL SECURITY;
CREATE POLICY estl_tenant ON estimate_lines
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id        uuid NOT NULL,
  invoice_no    bigint NOT NULL,
  status        text NOT NULL DEFAULT 'issued'
                CHECK (status IN ('issued','partial','paid','void')),
  subtotal_cents  bigint NOT NULL CHECK (subtotal_cents > 0),   -- pre-tax
  tax_cents       bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  retainage_bps   int NOT NULL DEFAULT 0 CHECK (retainage_bps BETWEEN 0 AND 5000),
  retainage_cents bigint NOT NULL DEFAULT 0 CHECK (retainage_cents >= 0),
  due_now_cents   bigint NOT NULL CHECK (due_now_cents >= 0),   -- total − retainage
  paid_cents      bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  journal_entry_id uuid,
  memo          text NOT NULL DEFAULT '',
  issued_on     date NOT NULL,
  created_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, invoice_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id)
);
CREATE INDEX inv_tenant_job_idx ON invoices(tenant_id, job_id);
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE  ROW LEVEL SECURITY;
CREATE POLICY inv_tenant ON invoices
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

-- Payments are money history: APPEND-ONLY, both layers (grant + trigger).
CREATE TABLE payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id  uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method      text NOT NULL DEFAULT 'manual'
              CHECK (method IN ('manual','check','ach','card','stripe')),
  reference   text,
  journal_entry_id uuid,
  received_on date NOT NULL,
  created_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id)
);
CREATE INDEX pay_tenant_invoice_idx ON payments(tenant_id, invoice_id);
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE  ROW LEVEL SECURITY;
CREATE POLICY pay_tenant ON payments
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
CREATE TRIGGER payments_immutable
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();

-- grants
GRANT SELECT, INSERT, UPDATE ON pricebook_items, estimates, estimate_options, estimate_lines, invoices TO app_user;
GRANT SELECT, INSERT ON payments TO app_user;  -- append-only
