-- Change orders — the document that legitimately moves an awarded contract.
--
-- Migration 0043 built the movement ledger and made `approveEstimate` refuse a
-- second award. This is the thing it refuses IN FAVOUR OF: a numbered document
-- with a scope, a price, a reason, and somebody's approval on it.
--
-- Contractors bleed money here more than almost anywhere else — work gets
-- added on a Tuesday, nobody writes it down, and it is argued about at final
-- billing. ServiceTitan and Housecall Pro both have this; today we have
-- nothing, and the WIP math has been quietly waiting for it since S3.
--
-- ── What it does NOT do ───────────────────────────────────────────────────
-- It posts NOTHING to the general ledger, deliberately. In this system the
-- contract is an operational number: revenue recognises through WIP (earned =
-- contract x pct-complete) and through invoices. A change order moves the
-- baseline those two read; it is not itself a transaction. Posting one would
-- double-count the moment the work is actually invoiced.

CREATE TABLE change_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id       uuid NOT NULL,
  -- Per-tenant, human-facing. "CO #7 on the Alvarez job" is how this gets
  -- talked about on the phone.
  co_no        int NOT NULL,
  status       text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','approved','declined','void')),
  title        text NOT NULL,
  -- WHY the work changed. Not decoration: at final billing this sentence is
  -- the difference between a conversation and a dispute.
  reason       text NOT NULL DEFAULT '',
  -- SIGNED, and a cached sum of the lines. Negative on a deduct.
  total_cents  bigint NOT NULL DEFAULT 0,
  -- Who said yes, and when. 'office' when the shop records a verbal yes,
  -- 'customer' when they tapped approve in their own portal — a distinction
  -- that matters if it is ever argued about.
  approved_by  text NOT NULL DEFAULT '',
  approved_via text NOT NULL DEFAULT '' CHECK (approved_via IN ('','office','customer')),
  approved_at  timestamptz,
  decided_note text NOT NULL DEFAULT '',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, co_no),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id),
  -- An approval with no timestamp and no approver is not an approval. Same
  -- shape as certified_payrolls' `certified_needs_real_deductions`: the CHECK
  -- makes the claim un-fakeable rather than merely discouraged.
  CONSTRAINT approved_needs_a_signer CHECK (
    status <> 'approved' OR (approved_at IS NOT NULL AND approved_by <> '' AND approved_via <> '')
  )
);
ALTER TABLE change_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_orders FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON change_orders
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON change_orders TO app_user;
CREATE INDEX change_orders_job_idx ON change_orders (tenant_id, job_id, co_no);

CREATE TABLE change_order_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  change_order_id  uuid NOT NULL,
  description      text NOT NULL,
  qty_x100         int NOT NULL CHECK (qty_x100 > 0),
  -- SIGNED: a deduct is a negative unit price, not a separate concept. That
  -- is what keeps the math one code path (see estimating/internal/contract.ts).
  unit_price_cents bigint NOT NULL,
  line_total_cents bigint NOT NULL,
  line_no          int NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, change_order_id) REFERENCES change_orders (tenant_id, id)
);
ALTER TABLE change_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_order_lines FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON change_order_lines
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON change_order_lines TO app_user;
CREATE INDEX change_order_lines_co_idx ON change_order_lines (tenant_id, change_order_id, line_no);

-- The counter, alongside job_no / invoice_no / credit_memo_no.
SELECT app.next_counter('change_order_no') WHERE false;

COMMENT ON TABLE change_orders IS
  'A numbered document that moves an awarded contract. Approving one writes a '
  'signed row into contract_movements; it posts NOTHING to the ledger, because '
  'the contract is an operational baseline and revenue recognises through WIP '
  'and invoices. See migrations 0043 and 0046.';
COMMENT ON CONSTRAINT approved_needs_a_signer ON change_orders IS
  'An approval with no timestamp and no approver is not an approval.';
