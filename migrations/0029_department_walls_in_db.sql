-- Department walls, enforced by the DATABASE (was: route guards only).
--
-- app.can_see_department() has existed since 0001 and backed NO policy. The
-- comment in src/lib/db/tenant.ts claimed "sensitive modules (HR/payroll, GL)
-- are further row-scoped by this set"; nothing row-scoped anything. The review
-- found the cost of that: GET /api/wip and GET /api/jobs/[id]/costing shipped
-- with a bare requireScope(), and /api/agents/overview handed every action
-- PAYLOAD — raw bank lines, vendor amounts, per-worker burdened pay — to any
-- member. The route fixes land in the same commit; this is the backstop, so
-- the NEXT forgotten route fails closed instead of leaking.
--
-- Scope, stated honestly: this covers the two surfaces where a wall is
-- unambiguous and no legitimate cross-department reader exists.
--
--   bank_transactions — read only by bank-rec, which is financials-walled
--                       on every route.
--   agent_actions     — the demonstrated leak. The required department is
--                       stamped on the row from the kind's own registry
--                       entry, so the DB knows what the TS layer knows.
--
-- Deliberately NOT walled here, because each has a legitimate reader outside
-- the owning department, and a policy that breaks the product is worse than a
-- policy that is honest about its edges:
--
--   workers        — scheduling-dispatch and intake both read names to assign
--                    work. Walling to 'hr' would break the dispatch board.
--   cost_entries   — field-ops writes and reads these from the job screen.
--   journal_lines  — sales-invoicing reads GL detail for an invoice (store.ts
--                    :255), and a tech invoices on-site by design.
--   bills          — inventory and reporting both read them.
--
-- Those four stay route-enforced. Narrowing them needs a per-row department
-- tag like the one added to agent_actions below, not a blanket policy.
--
-- RESTRICTIVE is the right modality: it ANDs with the existing permissive
-- tenant policy rather than widening anything. Tenant isolation still decides
-- first; this can only ever subtract.
--
-- Owner/admin are safe by construction: resolveScope() expands their grant set
-- to every real department key in the tenant before the GUC is set
-- (directory.ts), so app.current_departments() carries real keys for them —
-- there is no wildcard to special-case here.

-- ---------------------------------------------------------- bank_transactions
CREATE POLICY bank_txn_department ON bank_transactions
  AS RESTRICTIVE
  FOR ALL
  USING (app.can_see_department('financials'))
  WITH CHECK (app.can_see_department('financials'));

-- ------------------------------------------------------------- agent_actions
-- Which wall this card sits behind. NULL = no department requirement (e.g.
-- dispatch.assign, intake.book — role-gated but not walled).
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS department_key text;

COMMENT ON COLUMN agent_actions.department_key IS
  'Department wall this action sits behind, copied from KINDS[kind].requires '
  '.departments at propose time. NULL means the kind has no department '
  'requirement. Enforced by the agent_action_department RESTRICTIVE policy.';

-- Backfill from what the registry declares today, so the policy is correct for
-- rows that already exist rather than only for new ones. Going forward the
-- propose path stamps this from KINDS[kind].requires.departments, so this list
-- is a one-time catch-up, not a second source of truth to keep in sync.
UPDATE agent_actions SET department_key = 'financials'
 WHERE department_key IS NULL
   AND kind IN ('echo.money', 'bank.categorize', 'ap.billDraft',
                'inventory.reorder', 'ar.dunningDraft');
UPDATE agent_actions SET department_key = 'hr'
 WHERE department_key IS NULL AND kind = 'time.postWeek';

CREATE POLICY agent_action_department ON agent_actions
  AS RESTRICTIVE
  FOR ALL
  USING (department_key IS NULL OR app.can_see_department(department_key))
  WITH CHECK (department_key IS NULL OR app.can_see_department(department_key));

CREATE INDEX IF NOT EXISTS agent_actions_department_idx
  ON agent_actions (tenant_id, department_key);
