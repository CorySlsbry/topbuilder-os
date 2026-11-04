-- 0053 — split one bank line across jobs, and prove the bank actually agrees.
--
-- Two gaps on the bank screen, both of them the kind a bookkeeper hits on
-- their first afternoon with the product.

-- ═════════════════════════════════════════ 1. splitting a transaction
-- A $4,120 supply-house charge covering three jobs is not one categorization
-- — it is three. Until now the screen could only answer a line with a SINGLE
-- category or a SINGLE job, so the honest options were to code the whole
-- thing to one job (wrong on two jobs) or to "office supplies" (wrong on all
-- three, and invisible on every job report).
--
-- The split lives in the RESOLUTION LOG rather than in a new table: a split
-- IS an answer to a bank line, and the log already records who answered, when
-- and why. Each part is a row sharing one `seq`, so the whole answer is
-- readable as one decision — which is what it was.
ALTER TABLE bank_txn_resolutions
  ADD COLUMN IF NOT EXISTS amount_cents bigint;

-- Which part of a split this row is. NULL for a whole-line answer, so every
-- row written before this migration keeps meaning exactly what it meant.
ALTER TABLE bank_txn_resolutions
  ADD COLUMN IF NOT EXISTS split_no int;

-- 'split' joins the closed set of actions. Dropped by lookup, never by a
-- guessed constraint name.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'bank_txn_resolutions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%job-cost%';
  IF cname IS NULL THEN
    RAISE EXCEPTION 'bank_txn_resolutions action CHECK not found — did 0050 change?';
  END IF;
  EXECUTE format('ALTER TABLE bank_txn_resolutions DROP CONSTRAINT %I', cname);
END $$;
ALTER TABLE bank_txn_resolutions ADD CONSTRAINT btr_action_check
  CHECK (action IN ('expense','job-cost','personal','exclude','unmatch','split'));

-- The seq is no longer unique on its own: a three-way split is three rows
-- sharing one seq, distinguished by split_no. Whole-line answers keep
-- split_no NULL, and NULLs are distinct in a UNIQUE index — which would let
-- two whole-line answers share a seq. NULLS NOT DISTINCT closes that.
ALTER TABLE bank_txn_resolutions
  DROP CONSTRAINT IF EXISTS bank_txn_resolutions_tenant_id_txn_id_seq_key;
ALTER TABLE bank_txn_resolutions
  ADD CONSTRAINT btr_seq_part_uk UNIQUE NULLS NOT DISTINCT (tenant_id, txn_id, seq, split_no);

-- ═════════════════════════════════════════ 2. reconcile to a real balance
-- ⛔ "RECONCILED" MEANT "THE QUEUE IS EMPTY", WHICH IS NOT RECONCILED.
--
-- The existing check is that every line dated on or before the period end has
-- an answer. That is necessary and nowhere near sufficient: a statement line
-- that never imported, a duplicate the dedupe missed, a hand-entered payment
-- that never happened — none of them leave anything in the queue, and all of
-- them mean the books do not match the bank.
--
-- The only test that catches those is the one every bookkeeper already knows:
-- does the ledger balance of the cash account equal the ENDING BALANCE ON THE
-- STATEMENT? Recording the number the bank printed, and refusing to lock the
-- period unless it agrees, is the difference between an attestation and a
-- checkbox.
ALTER TABLE reconciliations
  ADD COLUMN IF NOT EXISTS statement_ending_cents bigint;
ALTER TABLE reconciliations
  ADD COLUMN IF NOT EXISTS book_balance_cents bigint;
ALTER TABLE reconciliations
  ADD COLUMN IF NOT EXISTS difference_cents bigint NOT NULL DEFAULT 0;

-- A locked period with a difference is allowed ONLY with a written reason —
-- sometimes a real one exists (a bank error being chased, a timing item), and
-- a system that refuses outright gets worked around by not reconciling at
-- all. What it must never be is silent.
ALTER TABLE reconciliations
  ADD COLUMN IF NOT EXISTS difference_reason text NOT NULL DEFAULT '';
ALTER TABLE reconciliations
  ADD CONSTRAINT rec_difference_explained
  CHECK (difference_cents = 0 OR length(difference_reason) > 0);

-- ── proof ────────────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*) INTO n FROM pg_constraint
   WHERE conrelid = 'bank_txn_resolutions'::regclass AND conname = 'btr_seq_part_uk';
  IF n <> 1 THEN
    RAISE EXCEPTION 'the split uniqueness constraint did not land';
  END IF;

  SELECT COUNT(*) INTO n FROM pg_constraint
   WHERE conrelid = 'reconciliations'::regclass AND conname = 'rec_difference_explained';
  IF n <> 1 THEN
    RAISE EXCEPTION 'the reconciliation difference CHECK did not land';
  END IF;
  RAISE NOTICE 'bank split + statement-balance schema is in place';
END $$;
