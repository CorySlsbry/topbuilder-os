-- The Membership stack + CPA pair (Cory 2026-08-03): the five gaps from the
-- ST/HCP/QBO analysis, as one schema. Decisions encoded here, as decided:
--
--   * Plans bill monthly (autopay, card-on-file) OR annual (prepaid invoice),
--     configured per plan.
--   * Annual prepay parks in 2430 Deferred income (already in every tenant's
--     NAHB chart) and is EARNED PER COMPLETED VISIT — visitReleaseSchedule()
--     splits it so the sum is exact and the last visit takes the remainder.
--     Monthly fees earn in their month; nothing defers.
--   * Member discounts and credit memos post to 3490 Sales concessions and
--     discounts — the SEEDED contra-revenue account, not an invented one.
--   * 3138 Service agreement revenue is created per tenant below (3137 is
--     "Sales, repairs"; membership revenue sits beside it).
--   * Card data never touches our screens: saved_payment_methods stores
--     Stripe references only (pm id, brand, last4) — the customer enters the
--     card in Stripe's element via their portal.
--   * Manual adjusting JEs need NO new table — journal_entries with
--     source_type 'manual'; the route enforces bookkeeper/owner/admin + aal2.

-- ============================================================ 1. EQUIPMENT
-- The memory of a service business: which units live at which customer, and
-- what has been done to them. Anchors agreements ("we maintain these units")
-- and makes visit #2 faster than visit #1.
CREATE TABLE equipment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id  uuid NOT NULL,
  label        text NOT NULL,              -- "Upstairs unit", "Shop RTU #2"
  kind         text NOT NULL DEFAULT 'other'
    CHECK (kind IN ('ac','furnace','heat-pump','mini-split','water-heater','rtu','other')),
  make         text NOT NULL DEFAULT '',
  model        text NOT NULL DEFAULT '',
  serial       text NOT NULL DEFAULT '',
  installed_on date,
  warranty_until date,
  notes        text NOT NULL DEFAULT '',
  retired      boolean NOT NULL DEFAULT false,  -- replaced units keep history
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
ALTER TABLE equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON equipment
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON equipment TO app_user;
CREATE INDEX equipment_customer_idx ON equipment (tenant_id, customer_id) WHERE NOT retired;

-- Which units a job touched — the per-unit service history is this join
-- read backwards through jobs.
CREATE TABLE job_equipment (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id       uuid NOT NULL,
  equipment_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, job_id, equipment_id),
  FOREIGN KEY (tenant_id, job_id)       REFERENCES jobs (tenant_id, id),
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment (tenant_id, id)
);
ALTER TABLE job_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_equipment FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_equipment
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON job_equipment TO app_user;

-- ======================================================= 2. CARD-ON-FILE
-- Stripe REFERENCES only. The pm is created by the CUSTOMER in a Stripe
-- element (portal); the office never sees a card number, which keeps us out
-- of PCI scope and honors the no-raw-credentials rule.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS sms_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_opt_out boolean NOT NULL DEFAULT false;

CREATE TABLE saved_payment_methods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL,
  stripe_pm_id  text NOT NULL,
  brand         text NOT NULL DEFAULT '',
  last4         text NOT NULL DEFAULT '',
  exp_month     int,
  exp_year      int,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','detached')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, stripe_pm_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
ALTER TABLE saved_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_payment_methods FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saved_payment_methods
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
-- Payment instruments are financials-walled in the DB, same as bank data.
CREATE POLICY spm_department ON saved_payment_methods
  AS RESTRICTIVE FOR ALL
  USING (app.can_see_department('financials'))
  WITH CHECK (app.can_see_department('financials'));
GRANT SELECT, INSERT, UPDATE ON saved_payment_methods TO app_user;

-- ======================================================== 3. AGREEMENTS
CREATE TABLE membership_plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL,                       -- "Comfort Club"
  billing        text NOT NULL CHECK (billing IN ('monthly','annual')),
  price_cents    bigint NOT NULL CHECK (price_cents >= 0),
  visits_per_year int NOT NULL DEFAULT 2 CHECK (visits_per_year BETWEEN 0 AND 12),
  discount_bps   int NOT NULL DEFAULT 0 CHECK (discount_bps BETWEEN 0 AND 10000),
  -- Target months for visits, e.g. {4,10} = spring/fall. Empty = spread.
  target_months  int[] NOT NULL DEFAULT '{}',
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
ALTER TABLE membership_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_plans FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON membership_plans
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON membership_plans TO app_user;

CREATE TABLE agreements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id        uuid NOT NULL,
  customer_id    uuid NOT NULL,
  status         text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','past_due','canceled','expired')),
  started_on     date NOT NULL,
  -- The current plan year (annual) or billing month (monthly).
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  -- Monthly autopay charges this pm; NULL = invoice-and-collect.
  payment_method_id uuid,
  -- Annual prepay: what parked in 2430 for THIS period, and how much each
  -- completed visit releases (the exact schedule, so the sum invariant that
  -- rec.test.ts proves survives storage).
  deferred_total_cents bigint NOT NULL DEFAULT 0 CHECK (deferred_total_cents >= 0),
  release_schedule bigint[] NOT NULL DEFAULT '{}',
  visits_completed int NOT NULL DEFAULT 0 CHECK (visits_completed >= 0),
  canceled_at    timestamptz,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id)     REFERENCES membership_plans (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_method_id)
    REFERENCES saved_payment_methods (tenant_id, id)
);
ALTER TABLE agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreements FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agreements
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON agreements TO app_user;
CREATE INDEX agreements_customer_idx ON agreements (tenant_id, customer_id);
CREATE INDEX agreements_active_idx   ON agreements (tenant_id, status) WHERE status = 'active';

CREATE TABLE agreement_visits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agreement_id  uuid NOT NULL,
  due_on        date NOT NULL,               -- month bucket (1st of month)
  status        text NOT NULL DEFAULT 'due'
    CHECK (status IN ('due','booked','completed','skipped')),
  job_id        uuid,                        -- the tune-up job, once booked
  completed_on  date,
  -- What THIS visit released from 2430 when completed (0 for monthly plans).
  released_cents bigint NOT NULL DEFAULT 0 CHECK (released_cents >= 0),
  journal_entry_id uuid,                     -- the release posting
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, agreement_id, due_on),
  FOREIGN KEY (tenant_id, agreement_id) REFERENCES agreements (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id)       REFERENCES jobs (tenant_id, id)
);
ALTER TABLE agreement_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreement_visits FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agreement_visits
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON agreement_visits TO app_user;
CREATE INDEX agreement_visits_due_idx ON agreement_visits (tenant_id, status, due_on)
  WHERE status = 'due';

-- Units covered by an agreement ("we maintain these two systems").
CREATE TABLE agreement_equipment (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agreement_id uuid NOT NULL,
  equipment_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, agreement_id, equipment_id),
  FOREIGN KEY (tenant_id, agreement_id) REFERENCES agreements (tenant_id, id),
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment (tenant_id, id)
);
ALTER TABLE agreement_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreement_equipment FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agreement_equipment
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON agreement_equipment TO app_user;

-- 3138 Service agreement revenue, per tenant. GUC loop, NOT set-based:
-- on Cloud SQL postgres is not a true superuser, so FORCE RLS binds the
-- migration role too (the 0034 lesson — it passed locally and failed in
-- production).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);
    INSERT INTO chart_of_accounts (tenant_id, code, name, type, section, description)
    SELECT t.id, '3138', 'Service agreement revenue', 'revenue',
           '3000-3990 Sales, Revenues, Cost of Sales',
           'Membership / maintenance agreement revenue, earned per completed '
           'visit (annual prepay) or monthly (monthly plans).'
     WHERE NOT EXISTS (
       SELECT 1 FROM chart_of_accounts c WHERE c.tenant_id = t.id AND c.code = '3138'
     );
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END $$;

-- ===================================================== 4. NOTIFICATIONS
CREATE TABLE comms_settings (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- Per-tenant Twilio number (Cory 2026-08-03: per-tenant from day one).
  -- A2P registration takes days per tenant, so notifications FALL BACK to
  -- email until sms_status is 'active'.
  sms_number    text NOT NULL DEFAULT '',
  sms_status    text NOT NULL DEFAULT 'none'
    CHECK (sms_status IN ('none','pending_a2p','active')),
  reminder_enabled   boolean NOT NULL DEFAULT true,
  on_my_way_enabled  boolean NOT NULL DEFAULT true,
  receipt_enabled    boolean NOT NULL DEFAULT true,
  visit_due_enabled  boolean NOT NULL DEFAULT true,
  google_review_url  text NOT NULL DEFAULT '',
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE comms_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms_settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON comms_settings
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON comms_settings TO app_user;

-- Every outbound message, whatever happened to it. Support answers "did the
-- reminder go out?" from here; TCPA answers "when did they opt out?" from
-- the customers columns + the suppressed rows here.
CREATE TABLE notification_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid,
  kind        text NOT NULL,          -- 'reminder','on_my_way','receipt','visit_due'
  channel     text NOT NULL CHECK (channel IN ('sms','email')),
  recipient   text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('sent','failed','suppressed','fallback')),
  detail      text NOT NULL DEFAULT '',   -- provider id or failure reason
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_log
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT ON notification_log TO app_user;
CREATE INDEX notification_log_recent_idx ON notification_log (tenant_id, created_at DESC);

-- ================================================ 5. CREDIT MEMOS / REFUNDS
-- A credit memo is the DOCUMENT that reduces what a customer owes; a refund
-- is MONEY going back. Separate objects because they post differently:
--   memo, applied to an open invoice: DR 3490 (or original revenue) / CR 1210 AR
--   memo, on account:                 DR 3490 / CR 2010 Contract deposits
--   refund of an on-account credit:   DR 2010 / CR 1020 Cash
-- Invoice VOID is not a row here — it is a reversing journal entry plus
-- status, only while unpaid, and only into an OPEN period.
CREATE TABLE credit_memos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id  uuid NOT NULL,
  invoice_id   uuid,                        -- NULL = credit on account
  memo_no      bigint NOT NULL,             -- per-tenant counter
  reason       text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status       text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','applied','refunded','voided')),
  journal_entry_id uuid,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, memo_no),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
ALTER TABLE credit_memos ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_memos FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_memos
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY credit_memo_department ON credit_memos
  AS RESTRICTIVE FOR ALL
  USING (app.can_see_department('financials'))
  WITH CHECK (app.can_see_department('financials'));
GRANT SELECT, INSERT, UPDATE ON credit_memos TO app_user;

CREATE TABLE refunds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  credit_memo_id uuid,
  payment_id    uuid,                       -- the original payment, if Stripe
  method        text NOT NULL CHECK (method IN ('stripe','check','ach','cash')),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  stripe_refund_id text,
  status        text NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded','pending','settled','failed')),
  journal_entry_id uuid,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- A Stripe refund maps to exactly one row — webhook retries must not
  -- double-post, same law as every other provider reference in the system.
  UNIQUE (tenant_id, stripe_refund_id),
  FOREIGN KEY (tenant_id, credit_memo_id) REFERENCES credit_memos (tenant_id, id)
);
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refunds
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY refund_department ON refunds
  AS RESTRICTIVE FOR ALL
  USING (app.can_see_department('financials'))
  WITH CHECK (app.can_see_department('financials'));
GRANT SELECT, INSERT, UPDATE ON refunds TO app_user;

-- Invoice VOID: no schema change needed — invoices.status has allowed 'void'
-- since 0006 ('issued','partial','paid','void'). What was missing is the
-- LOGIC (reversing entry, unpaid-only, open-period-only), which lives in the
-- sales-invoicing module, not here. Verified against 0006 before writing
-- this, because the first draft of this migration would have REPLACED that
-- constraint with a guessed enum and broken every invoice insert at its
-- default status.

-- ============================================ invoices carry memberships too
-- A membership invoice has no JOB — the whole reason agreements exist is
-- revenue that isn't a job. job_id becomes nullable; agreement_id says what
-- the invoice IS when job_id is NULL. The four CRM queries that inner-joined
-- invoices→jobs go LEFT JOIN in the same commit (portal, dunning, reviews) —
-- a member has to SEE the renewal invoice in their portal to pay it.
ALTER TABLE invoices ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS agreement_id uuid;
ALTER TABLE invoices ADD CONSTRAINT invoices_agreement_fk
  FOREIGN KEY (tenant_id, agreement_id) REFERENCES agreements (tenant_id, id);
-- An invoice is ABOUT something: a job, an agreement — never neither.
ALTER TABLE invoices ADD CONSTRAINT invoices_subject_check
  CHECK (job_id IS NOT NULL OR agreement_id IS NOT NULL);
