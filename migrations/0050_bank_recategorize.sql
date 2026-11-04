-- 0050_bank_recategorize — categorize one line at a time, and FIX IT LATER.
--
-- The bank screen could categorize a line exactly once, and only by typing a
-- raw account code into a text box. Two things were missing, and both are
-- table stakes for anyone coming off QuickBooks:
--
--   1. PICK A CATEGORY BY NAME. "6210" is not a category, it is a code the
--      owner has to already know. (No schema change — see categories.ts.)
--   2. CHANGE IT AFTERWARDS. Everyone miscodes. A book you cannot correct is
--      a book people stop trusting, and then stop using.
--
-- ── WHY A CORRECTION IS TWO POSTINGS, NOT AN EDIT ────────────────────────
-- The journal is immutable by design (0002): posted rows cannot be updated or
-- deleted, at the grant level AND by trigger. So "change the category" is
-- exactly what a CPA would do by hand — reverse the original entry, post the
-- new one — and the ledger keeps both. That is the difference between a
-- correction and a cover-up, and it is what makes these books defensible to a
-- surety, a lender, or an auditor.
--
-- Two things had to move for that to be possible:

-- ═════════════════════════════════════════════ 1. offsetting cost entries
-- `cost_entries` is the operational job-cost ledger and it is append-only for
-- the same reason the journal is. Its amount CHECK was `> 0`, which made an
-- offsetting row impossible — so a job cost coded to the WRONG JOB could be
-- reversed in the GL and still sit on that job's cost report forever.
--
-- Widen to `<> 0` so a correction is a NEGATIVE row that nets the original to
-- zero. Every reader already SUMs (job costing, WIP, reporting, the profit
-- math), so they net correctly with no code change — which is precisely why
-- this is the safe shape rather than a delete.
--
-- The constraint is dropped BY LOOKUP, never by a guessed name: this table
-- was created in 0004 and an auto-named constraint is not a contract.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'cost_entries'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%amount_cents > 0%';
  IF cname IS NULL THEN
    RAISE EXCEPTION 'cost_entries amount CHECK not found — did 0004 change?';
  END IF;
  EXECUTE format('ALTER TABLE cost_entries DROP CONSTRAINT %I', cname);
END $$;

ALTER TABLE cost_entries
  ADD CONSTRAINT cost_entries_amount_nonzero CHECK (amount_cents <> 0);

-- Provenance: which row this one backs out. Composite-FK'd to the same tenant
-- like every other parent link in this schema.
ALTER TABLE cost_entries ADD CONSTRAINT ce_tenant_id_uk UNIQUE (tenant_id, id);
ALTER TABLE cost_entries ADD COLUMN reverses_id uuid;
ALTER TABLE cost_entries
  ADD CONSTRAINT ce_reverses_fk
  FOREIGN KEY (tenant_id, reverses_id) REFERENCES cost_entries(tenant_id, id);

-- A reversal is not a receipt, a timesheet, a bill or a hand entry. Naming it
-- keeps "where did this cost come from?" answerable, and keeps a correction
-- from masquerading as an original.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'cost_entries'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%source_type%receipt%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE cost_entries DROP CONSTRAINT %I', cname);
  END IF;
END $$;
ALTER TABLE cost_entries ADD CONSTRAINT cost_entries_source_type_check
  CHECK (source_type IN ('receipt','time','bill','manual','reversal'));

-- ═════════════════════════════════════════════ 2. the correction audit log
-- The LEDGER already records what changed — reversal plus re-post, in the
-- book of record, where it cannot be quietly rewritten. What the ledger does
-- NOT record is WHO decided and WHY, in the words of the person who decided.
--
-- Append-only for the same reason as everything else on this side of the
-- product: an audit trail somebody can edit is not an audit trail. There is
-- no `superseded_at` column and that is deliberate — the current coding is
-- simply the highest `seq`, so no row is ever rewritten to mark it stale.
CREATE TABLE bank_txn_resolutions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  txn_id        uuid NOT NULL,
  /** 1 = the original answer, 2+ = each correction after it. */
  seq           int  NOT NULL CHECK (seq >= 1),
  action        text NOT NULL
                CHECK (action IN ('expense','job-cost','personal','exclude','unmatch')),
  account_code  text,
  job_id        uuid,
  cost_code     text,
  cost_kind     text,
  /** The posting THIS answer created (null for exclude/unmatch). */
  journal_entry_id uuid,
  /** The reversing posting that backed out the PREVIOUS answer (null at seq 1). */
  undo_entry_id    uuid,
  /** Why it changed, in the bookkeeper's own words. Required on a correction. */
  reason        text NOT NULL DEFAULT '',
  resolved_by   text NOT NULL DEFAULT '',
  resolved_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, txn_id, seq),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, txn_id) REFERENCES bank_transactions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, undo_entry_id)    REFERENCES journal_entries(tenant_id, id)
);
CREATE INDEX btr_txn_idx ON bank_txn_resolutions(tenant_id, txn_id, seq DESC);
ALTER TABLE bank_txn_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_txn_resolutions FORCE  ROW LEVEL SECURITY;
CREATE POLICY btr_tenant ON bank_txn_resolutions
  USING      (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
CREATE TRIGGER bank_txn_resolutions_immutable
  BEFORE UPDATE OR DELETE ON bank_txn_resolutions
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();

-- Append-only at the grant level too, the same two-layer defense the journal
-- and cost_entries use: no UPDATE, no DELETE, for anybody.
GRANT SELECT, INSERT ON bank_txn_resolutions TO app_user;

-- ── the financials wall ──────────────────────────────────────────────────
-- 0029 moved department walls into the database. This table is bank data, so
-- it carries the same wall as `bank_transactions`: a dispatcher who cannot
-- see the bank feed must not be able to read it through its audit log.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'can_see_department'
                   AND pronamespace = 'app'::regnamespace) THEN
    RAISE EXCEPTION 'app.can_see_department() missing — 0029 must run first';
  END IF;
END $$;
CREATE POLICY btr_department ON bank_txn_resolutions
  AS RESTRICTIVE
  FOR ALL
  USING      (app.can_see_department('financials'))
  WITH CHECK (app.can_see_department('financials'));

-- ── proof it is usable, in the migration itself ──────────────────────────
DO $$
DECLARE t uuid; n int;
BEGIN
  SELECT id INTO t FROM tenants LIMIT 1;
  IF t IS NULL THEN
    RAISE NOTICE 'no tenants yet — skipping the write probe';
    RETURN;
  END IF;
  PERFORM set_config('app.current_tenant', t::text, true);

  -- The whole point of widening the CHECK: a negative offset must be legal.
  SELECT COUNT(*) INTO n FROM pg_constraint
   WHERE conrelid = 'cost_entries'::regclass
     AND conname = 'cost_entries_amount_nonzero';
  IF n <> 1 THEN
    RAISE EXCEPTION 'cost_entries_amount_nonzero did not land';
  END IF;
  RAISE NOTICE 'bank recategorization schema is in place';
END $$;
