-- Two dates the cash plan needs and the schema never recorded.
--
-- The existing forecast assumes every invoice is paid 30 days after it was
-- issued and every purchase order lands... never, because purchase orders were
-- not in it at all. Both assumptions are hardcoded arithmetic standing in for
-- a fact nobody was ever asked for.
--
-- ⛔ NULLABLE, AND NOT BACKFILLED. On purpose.
--
-- A backfilled due date is a fact nobody recorded. Writing `issued_on + 30`
-- into a column called `due_on` converts an assumption into data: the next
-- reader cannot tell which invoices a human actually dated and which ones we
-- invented, and the assumption becomes permanent and unquestionable. The
-- reads coalesce instead, so an absent date stays visibly absent and the
-- fallback stays visibly a fallback.
--
-- The consequence, stated so it is a choice and not a surprise: the first
-- render after this migration is identical to today's for a shop with no
-- payment history, because the default collection lag is the same 30 days the
-- old code hardcoded. A shop with eight or more paid invoices will see its own
-- measured median instead — which is not an invented assumption, it is their
-- own behaviour, and the plan says out loud which one it used.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_on date;

COMMENT ON COLUMN invoices.due_on IS
  'When payment is actually due, when a human said so. NULL means nobody '
  'stated one and the plan falls back to issued_on + the measured collection '
  'lag. Never backfilled: an invented date is indistinguishable from a real '
  'one once it is in the column.';

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS expected_on date;

COMMENT ON COLUMN purchase_orders.expected_on IS
  'When this commitment is expected to be billed and paid. NULL means unknown '
  'and the plan treats the PO as undated rather than guessing a week for it.';

-- The plan reads open invoices by date, per tenant, every page load.
CREATE INDEX IF NOT EXISTS invoices_tenant_due_idx
  ON invoices (tenant_id, due_on)
  WHERE status IN ('issued', 'partial');

CREATE INDEX IF NOT EXISTS purchase_orders_tenant_expected_idx
  ON purchase_orders (tenant_id, expected_on)
  WHERE status = 'open';

-- Verify the columns are writable through the app role's existing grants
-- rather than assuming ALTER TABLE inherited them. A column an app cannot
-- write is a form that silently does nothing — the 0042 lesson.
DO $$
DECLARE
  t uuid;
  n int;
BEGIN
  SELECT id INTO t FROM tenants ORDER BY created_at LIMIT 1;
  IF t IS NULL THEN
    RAISE NOTICE 'no tenants yet — skipping the write probe';
    RETURN;
  END IF;
  PERFORM set_config('app.current_tenant', t::text, true);

  SELECT count(*)::int INTO n FROM invoices WHERE tenant_id = t;
  IF n = 0 THEN
    RAISE NOTICE 'tenant has no invoices — skipping the invoice write probe';
  ELSE
    UPDATE invoices SET due_on = due_on WHERE tenant_id = t;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
      RAISE EXCEPTION 'invoices.due_on UPDATE matched 0 rows — the policy does not admit writes';
    END IF;
  END IF;
  RAISE NOTICE 'cash-plan date columns are writable';
END $$;
