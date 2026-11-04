-- 0003_coa_tag — preserve the NAHB tag on chart_of_accounts + purge hatch.
--
-- (1) The raw NAHB tag carries information the statement/WIP slices need that
-- the coarse `type` enum flattens (e.g. wip-control identifies the WIP
-- schedule's control accounts 1410/1430/1440; contra-* drives sign display).
ALTER TABLE chart_of_accounts ADD COLUMN tag text;

-- (2) Tenant purge hatch. The ledger is immutable, but production-readiness
-- (data-deletion self-service / GDPR erasure) requires that deleting a TENANT
-- can cascade through journal rows. The immutability trigger now permits
-- deletes ONLY when the transaction-local GUC app.ledger_purge = 'on'.
-- Defense in depth is preserved: app_user has no DELETE grant on ledger
-- tables at all, so the hatch is reachable only by the privileged purge path
-- (a SECURITY DEFINER purge function ships with the export/delete slice).
CREATE OR REPLACE FUNCTION app.forbid_ledger_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND COALESCE(current_setting('app.ledger_purge', true), '') = 'on' THEN
    RETURN OLD; -- deliberate tenant purge in progress
  END IF;
  RAISE EXCEPTION 'ledger rows are immutable — post a reversing entry instead';
END $$;
