-- 0052_bonding — the fields and accounts a surety underwriter reads.
--
-- An underwriter is not reading a contractor's P&L out of curiosity. They are
-- answering exactly one question: "if this shop walks off a job, what does it
-- cost me?" Every schedule they ask for is instrumentation for that question,
-- and the shop that can produce those schedules straight out of its own
-- ledger — rather than out of two weeks of a CPA's cleanup — gets a decision
-- faster and usually a bigger line.
--
-- This product already generates better books than most 1-10 person shops
-- hand their accountant. What it could not produce was the FORMAT, and three
-- facts that no report can derive because nobody ever recorded them.

-- ═════════════════════════════════════════════ 1. facts about the contract
-- Everything here is a fact somebody signed, not a number to compute.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS started_on date;

-- The completion date column on a contracts-in-progress schedule. An
-- underwriter reads it against percent-complete: a job that is 40% done with
-- three weeks left is a different risk from one that is 40% done with six
-- months left.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS est_completion_on date;

-- Who the contract is WITH, when that is not who we invoice. A sub bills the
-- general contractor, and the underwriter wants the owner named too — a
-- three-party dispute is where bond claims come from.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_name text;

-- Fixed-price carries the estimating risk; cost-plus carries almost none;
-- time-and-materials carries none at all. Percent-complete means something
-- different on each, so the schedule discloses which it is rather than
-- presenting them as one homogeneous list.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS contract_type text NOT NULL DEFAULT 'fixed-price'
  CHECK (contract_type IN ('fixed-price','cost-plus','unit-price','time-and-materials'));

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS bonded boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS bond_number text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS surety_name text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS bond_premium_cents bigint
  CHECK (bond_premium_cents IS NULL OR bond_premium_cents >= 0);

-- ═════════════════════════════════════════════ 2. tangible net worth
-- Bonding capacity is sized off working capital and TANGIBLE net worth, and
-- "tangible" means equity less the assets a surety will not lend against:
-- goodwill and other intangibles, and money owed by the owner or a related
-- entity (which, in a claim, is money that does not come back).
--
-- Which accounts those are is a JUDGEMENT a CPA makes about a specific chart,
-- not something software can infer from an account name. So the chart carries
-- the classification, the accountant sets it, and the ratio panel shows its
-- work. Null — the default — means "an ordinary asset", so nothing changes
-- for a chart nobody has classified.
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS surety_class text
  CHECK (surety_class IS NULL OR surety_class IN ('intangible','related-party','non-current'));

-- ═════════════════════════════════════════════ 3. the bank line
-- An underwriter asks for the line of credit every time: limit, current
-- balance, when it expires, and whether it is personally guaranteed. It is
-- not derivable from a bank feed — an unused line is invisible in the ledger
-- precisely because it is unused, and an unused line is exactly the one that
-- makes a shop bondable.
CREATE TABLE credit_facilities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lender       text NOT NULL,
  kind         text NOT NULL DEFAULT 'line-of-credit'
               CHECK (kind IN ('line-of-credit','term-loan','equipment-loan','other')),
  limit_cents  bigint NOT NULL DEFAULT 0 CHECK (limit_cents >= 0),
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  rate_bps     int,
  matures_on   date,
  personally_guaranteed boolean NOT NULL DEFAULT false,
  notes        text NOT NULL DEFAULT '',
  updated_by   text NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
ALTER TABLE credit_facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_facilities FORCE  ROW LEVEL SECURITY;
CREATE POLICY cf_tenant ON credit_facilities
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
CREATE POLICY cf_department ON credit_facilities
  AS RESTRICTIVE FOR ALL
  USING      (app.can_see_department('financials'))
  WITH CHECK (app.can_see_department('financials'));
GRANT SELECT, INSERT, UPDATE, DELETE ON credit_facilities TO app_user;

-- ═════════════════════════════════════════════ 4. the WIP adjusting entry
-- ⛔ THE GAP THIS CLOSES IS THE WHOLE REASON THE SCHEDULE IS CREDIBLE.
--
-- Accounts 1265 (costs in excess of billings) and 2480 (billings in excess of
-- costs) have been in the seeded chart since day one and NOTHING has ever
-- posted to them. Over- and under-billings were computed for the WIP screen
-- and never journalized — so the balance sheet an underwriter reads does not
-- show the WIP asset at all, and the contracts-in-progress schedule could
-- never be tied to the trial balance. A schedule that does not tie is a
-- schedule an underwriter discounts.
--
-- This table records each posted adjustment so the next one can move the
-- balance to its new target rather than double-posting. One per as-of date,
-- which is also what makes the operation idempotent: run it twice on the same
-- snapshot and the second run has nothing to move.
CREATE TABLE wip_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  as_of        date NOT NULL,
  /** Target balances this adjustment moved the two accounts TO. */
  underbilled_cents bigint NOT NULL CHECK (underbilled_cents >= 0),
  overbilled_cents  bigint NOT NULL CHECK (overbilled_cents  >= 0),
  /** What actually moved, so the entry can be read back without the ledger. */
  under_delta_cents bigint NOT NULL,
  over_delta_cents  bigint NOT NULL,
  journal_entry_id  uuid,
  jobs_counted int NOT NULL DEFAULT 0,
  posted_by    text NOT NULL DEFAULT '',
  posted_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, as_of),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id)
);
CREATE INDEX wip_adj_tenant_idx ON wip_adjustments(tenant_id, as_of DESC);
ALTER TABLE wip_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE wip_adjustments FORCE  ROW LEVEL SECURITY;
CREATE POLICY wa_tenant ON wip_adjustments
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
CREATE POLICY wa_department ON wip_adjustments
  AS RESTRICTIVE FOR ALL
  USING      (app.can_see_department('financials'))
  WITH CHECK (app.can_see_department('financials'));
-- Append-only like everything else that records a posting: the entry it
-- points at cannot be edited, so neither can the record of it.
CREATE TRIGGER wip_adjustments_immutable
  BEFORE UPDATE OR DELETE ON wip_adjustments
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();
GRANT SELECT, INSERT ON wip_adjustments TO app_user;

-- ── proof ────────────────────────────────────────────────────────────────
DO $$
DECLARE t uuid; n int;
BEGIN
  -- ⛔ A TENANT THAT HAS A CHART, not merely the first tenant.
  --
  -- The first version of this probe was `SELECT id FROM tenants LIMIT 1` and
  -- it failed the migration outright — on a database whose first tenant was a
  -- throwaway fixture with an empty chart of accounts. That is not a broken
  -- chart, it is a tenant that was never seeded, and refusing to migrate
  -- because of one would block every real tenant behind it. The assertion
  -- that MATTERS is "a chart that exists contains 1265 and 2480", so that is
  -- the one made.
  SELECT a.tenant_id INTO t
    FROM chart_of_accounts a
   GROUP BY a.tenant_id
   ORDER BY COUNT(*) DESC
   LIMIT 1;

  IF t IS NULL THEN
    RAISE NOTICE 'no seeded chart in this database — skipping the probe';
    RETURN;
  END IF;
  PERFORM set_config('app.current_tenant', t::text, true);
  PERFORM set_config('app.current_departments', 'financials', true);

  -- The two accounts the adjustment posts to must exist, or the whole
  -- feature is a runtime error on a screen an owner is showing their agent.
  SELECT COUNT(*) INTO n FROM chart_of_accounts WHERE code IN ('1265','2480');
  IF n <> 2 THEN
    RAISE EXCEPTION
      'a seeded chart is missing 1265/2480 — the WIP adjustment cannot post';
  END IF;

  INSERT INTO credit_facilities (tenant_id, lender, limit_cents)
  VALUES (t, '__probe__', 0);
  DELETE FROM credit_facilities WHERE tenant_id = t AND lender = '__probe__';
  RAISE NOTICE 'bonding schema is in place';
END $$;
