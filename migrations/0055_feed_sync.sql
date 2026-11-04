-- 0055 — make a live bank feed RELIABLE, which is mostly about duplicates.
--
-- Every accounting product's bank feed fails the same two ways, and both of
-- them show up as duplicate transactions the owner has to clean up by hand:
--
--   1. The same transaction is imported twice because the dedupe key was
--      derived from date + amount + description, and the bank changed the
--      description between syncs.
--   2. A PENDING transaction is imported, then imported AGAIN when it posts
--      with a different amount (a card authorisation for $50 that settles at
--      $47.80 with a tip) or a different description.
--
-- The file-import path deduped on a fingerprint because a CSV has no stable
-- identifier. An aggregator DOES give one, and using it is the single biggest
-- reliability difference between a feed people trust and a feed people turn
-- off.

-- The provider's own id for this transaction. Unique per tenant, so a resync
-- of the same enrollment cannot double-post anything, ever.
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS provider_txn_id text;
CREATE UNIQUE INDEX IF NOT EXISTS bt_provider_txn_uk
  ON bank_transactions(tenant_id, provider_txn_id)
  WHERE provider_txn_id IS NOT NULL;

-- ── the connection's sync state ──────────────────────────────────────────
-- Text, not bytea: the token-encryption helper produces a self-describing
-- string blob (`v1:iv:tag:ciphertext`) and every other encrypted token in
-- this system is stored the same way. One format, one pair of functions.
ALTER TABLE feed_connections DROP COLUMN IF EXISTS access_token_enc;
ALTER TABLE feed_connections ADD COLUMN IF NOT EXISTS access_token_enc text;

-- How far back the next sync needs to look. Set to the newest POSTED date
-- seen, minus a lookback window — banks backdate, and a cursor that only
-- moves forward silently loses anything that lands late.
ALTER TABLE feed_connections ADD COLUMN IF NOT EXISTS synced_through date;

-- Counted so a screen can say "12 new, 3 already here" instead of "synced".
ALTER TABLE feed_connections ADD COLUMN IF NOT EXISTS last_sync_new int NOT NULL DEFAULT 0;
ALTER TABLE feed_connections ADD COLUMN IF NOT EXISTS last_sync_duplicate int NOT NULL DEFAULT 0;

-- ── where a transaction came from ───────────────────────────────────────
-- The CHECK allowed only 'file' and 'plaid' — 'plaid' having been written
-- when Plaid was assumed to be the only future provider. It is not: this
-- product's whole feed layer is provider-agnostic because QBO itself runs on
-- two aggregators and the 1033 rewrite may force a third. 'feed' is the
-- honest value; the provider's NAME lives on the connection row, where it
-- belongs and where it can change.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'bank_transactions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%plaid%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE bank_transactions DROP CONSTRAINT %I', cname);
  END IF;
END $$;
ALTER TABLE bank_transactions ADD CONSTRAINT bt_source_check
  CHECK (source IN ('file','feed','plaid'));

-- ── proof ────────────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*) INTO n FROM pg_indexes
   WHERE tablename = 'bank_transactions' AND indexname = 'bt_provider_txn_uk';
  IF n <> 1 THEN
    RAISE EXCEPTION 'the provider transaction-id unique index did not land — a resync could double-post';
  END IF;
  RAISE NOTICE 'feed sync schema is in place';
END $$;
