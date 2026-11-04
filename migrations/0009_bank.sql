-- 0009_bank — the bank plane: accounts, imports, transactions (the For-Review
-- queue), learning rules, and period reconciliations.
--
-- Design decisions (from the plan + Cory's directives):
--   * FILE import is first-class (CSV/OFX) — feeds degrade gracefully, the
--     books never block on an aggregator. Plaid slots in later (same table,
--     source='plaid').
--   * Dedupe by fingerprint (account + date + amount + normalized memo) —
--     re-importing a statement can never double-post.
--   * The review queue IS bank_transactions WHERE status='pending' — no
--     parallel queue table to drift out of sync.
--   * bank_rules LEARN: every confirmed categorization upserts a rule;
--     rules SUGGEST (the human gate stays — nothing posts itself).
--   * Reconciliation requires the queue at zero for the period, then locks.

CREATE TABLE bank_accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,                 -- "Chase Business Checking"
  gl_account_code text NOT NULL,            -- the COA cash account it maps to
  institution text,
  last4      text,
  source     text NOT NULL DEFAULT 'file' CHECK (source IN ('file','plaid')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts FORCE  ROW LEVEL SECURITY;
CREATE POLICY ba_tenant ON bank_accounts
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

CREATE TABLE statement_imports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL,
  filename   text NOT NULL,
  format     text NOT NULL CHECK (format IN ('csv','ofx')),
  rows_total int NOT NULL DEFAULT 0,
  rows_new   int NOT NULL DEFAULT 0,
  rows_duplicate int NOT NULL DEFAULT 0,
  imported_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_accounts(tenant_id, id)
);
ALTER TABLE statement_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE statement_imports FORCE  ROW LEVEL SECURITY;
CREATE POLICY si_tenant ON statement_imports
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

CREATE TABLE bank_transactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL,
  import_id  uuid,
  posted_on  date NOT NULL,
  /** SIGNED cents: negative = money out, positive = money in. */
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  description text NOT NULL,
  /** sha256(account|date|amount|normalized description) — the dedupe key. */
  fingerprint text NOT NULL,
  source     text NOT NULL DEFAULT 'file' CHECK (source IN ('file','plaid')),
  status     text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','matched','categorized','personal','excluded')),
  -- resolution links
  journal_entry_id uuid,                    -- posting created (or matched)
  resolved_by  text,
  resolved_at  timestamptz,
  -- suggestions computed at import (never auto-posted)
  suggested_rule_id uuid,
  personal_suspect  boolean NOT NULL DEFAULT false,
  personal_reason   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bank_account_id, fingerprint),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, import_id) REFERENCES statement_imports(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id)
);
CREATE INDEX bt_tenant_status_idx ON bank_transactions(tenant_id, status, posted_on);
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions FORCE  ROW LEVEL SECURITY;
CREATE POLICY bt_tenant ON bank_transactions
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

-- Learning rules: substring matcher → a categorization suggestion.
CREATE TABLE bank_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  matcher    text NOT NULL,                 -- lowercased substring, e.g. 'srs distribution'
  action     text NOT NULL CHECK (action IN ('expense','job-cost','personal')),
  account_code text,                        -- for action='expense'
  cost_kind  text,                          -- for action='job-cost'
  hit_count  int NOT NULL DEFAULT 0,
  created_from text NOT NULL DEFAULT 'user' CHECK (created_from IN ('user','learned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, matcher)
);
ALTER TABLE bank_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_rules FORCE  ROW LEVEL SECURITY;
CREATE POLICY br_tenant ON bank_rules
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

-- Period locks: reconcile requires the queue at ZERO through the period end.
CREATE TABLE reconciliations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL,
  period_end date NOT NULL,
  txn_count  int NOT NULL DEFAULT 0,
  reconciled_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bank_account_id, period_end),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_accounts(tenant_id, id)
);
ALTER TABLE reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliations FORCE  ROW LEVEL SECURITY;
CREATE POLICY rec_tenant ON reconciliations
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
-- Reconciliations are point-in-time attestations — immutable.
CREATE TRIGGER reconciliations_immutable
  BEFORE UPDATE OR DELETE ON reconciliations
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();

-- grants
GRANT SELECT, INSERT, UPDATE ON bank_accounts, statement_imports, bank_transactions, bank_rules TO app_user;
GRANT SELECT, INSERT ON reconciliations TO app_user;  -- append-only
