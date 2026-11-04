-- 0058 — one definition of "what we billed", enforced by the database.
--
-- ⛔ THE MEMBER DISCOUNT SPLIT THE MEANING OF `subtotal_cents` AND NINE
--    QUERIES KEPT READING THE OLD ONE.
--
-- 0056 added `discount_cents` and `issueInvoice` began storing the GROSS
-- (list) price in `subtotal_cents`, with the concession recorded separately
-- and posted to 3490 as contra-revenue. That is the correct INVOICE DOCUMENT
-- shape — a customer's invoice shows subtotal, then discount, then tax — and
-- it is the only shape that can answer "what did memberships cost us in
-- concessions this year?".
--
-- But `subtotal_cents` was already the source of nine other facts, every one
-- of which means "the pre-tax amount we actually billed":
--
--   job-costing/costing.ts   billedCents        -> true job profit
--   job-costing/bonding.ts   billed to date     -> the CIP schedule, and from
--                                                  there postWipAdjustment(),
--                                                  which JOURNALIZES it
--   forecast/store.ts        remaining contract -> the 13-week cash plan
--   reporting/store.ts       revenue MTD / 90d / avg invoice, customer totals
--   crm/store.ts             customer invoice totals
--   sales-invoicing/credit.ts credit-memo basis
--   sales-invoicing/store.ts THE OVERPAYMENT GUARD
--
-- The overpayment guard is the sharpest one. It computed
-- `subtotal_cents + tax_cents` as the invoice total while `due_now_cents`
-- was already computed on the NET. On a $10,000 invoice with a 15% member
-- discount, the guard would have accepted $10,700 against an invoice that
-- asked for $9,200 — posting $1,500 of cash against receivables that do not
-- exist, and it would balance, because the ledger only checks that debits
-- equal credits, not that they are true.
--
-- ── WHY A GENERATED COLUMN AND NOT NINE EDITS ────────────────────────────
-- Nine edits fix today. The tenth query — written next month by someone who
-- reasonably assumes `subtotal_cents` means what it has meant since 0005 —
-- reintroduces the bug, and it reintroduces it silently, because every one
-- of these figures is plausible when wrong.
--
-- STORED (Postgres has no VIRTUAL) means it cannot drift, cannot be inserted
-- into, and cannot be forgotten. The name says which of the two numbers you
-- are asking for, so choosing wrong now requires typing the wrong word
-- rather than not knowing there was a choice.

-- A discount larger than the invoice would make the net negative and every
-- downstream figure nonsense. `issueInvoice` clamps bps to 10000 so it
-- cannot happen from there, but a CHECK is what makes that true of every
-- future writer as well.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_discount_not_over_subtotal;
ALTER TABLE invoices ADD CONSTRAINT invoices_discount_not_over_subtotal
  CHECK (discount_cents <= subtotal_cents);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS net_subtotal_cents bigint
  GENERATED ALWAYS AS (subtotal_cents - discount_cents) STORED;

COMMENT ON COLUMN invoices.subtotal_cents IS
  'GROSS (list) pre-tax amount. Revenue is credited at this figure; the '
  'discount is contra-revenue in 3490. For "what we billed", use '
  'net_subtotal_cents.';
COMMENT ON COLUMN invoices.net_subtotal_cents IS
  'What the customer was actually billed, pre-tax: subtotal minus discount. '
  'Tax and due_now_cents are both computed on this. Every billed-to-date, '
  'revenue, cash-plan and overpayment figure reads THIS column.';

-- ── proof ────────────────────────────────────────────────────────────────
-- ⛔ This asserts a VALUE, not the existence of a column. 0054 shipped a
-- probe that only checked a CHECK constraint had landed and its INSERT had
-- silently affected zero rows across every tenant (see 0057). A migration
-- that proves only its own DDL proves nothing about the data.
DO $$
DECLARE
  t         record;
  bad       int;
  checked   int := 0;
BEGIN
  FOR t IN SELECT id, slug FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    SELECT count(*) INTO bad FROM invoices
     WHERE net_subtotal_cents <> subtotal_cents - discount_cents;
    IF bad > 0 THEN
      RAISE EXCEPTION 'net_subtotal_cents is not the difference on % row(s) in %', bad, t.slug;
    END IF;

    -- Undiscounted invoices — every invoice issued before 0056 — must be
    -- numerically unchanged, or this migration moved historical figures.
    SELECT count(*) INTO bad FROM invoices
     WHERE discount_cents = 0 AND net_subtotal_cents <> subtotal_cents;
    IF bad > 0 THEN
      RAISE EXCEPTION 'an undiscounted invoice changed value in %', t.slug;
    END IF;

    SELECT count(*) INTO checked FROM invoices;
  END LOOP;
  RAISE NOTICE 'net_subtotal_cents ties on every invoice (last tenant: % rows)', checked;
END $$;
