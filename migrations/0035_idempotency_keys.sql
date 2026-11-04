-- Request-level idempotency for every mutating route.
--
-- The audit that prompted this: 65 of 66 mutating routes had no request-level
-- protection at all. What existed was at the STORAGE layer — UNIQUE on
-- payments.reference, on bill_payments.provider_ref, on agent_actions
-- .idempotency_key, plus the Stripe event-id dedupe. Those cover paths that
-- happen to have a natural key.
--
-- Nothing covered the ordinary case: a contractor on one bar of signal taps
-- "Record payment", sees nothing happen, and taps it again. Two POSTs, no
-- natural key, two payments, two journal entries. The books balance — they are
-- just wrong, and the error surfaces weeks later as a bank reconciliation that
-- will not tie.
--
-- Same shape from a browser retry, a flaky proxy, or a user refreshing a
-- form-submit.
--
-- ── The protocol (Stripe's, because it is the one that works) ──────────────
--
--   1. CLAIM the key before doing any work, in its OWN transaction so the
--      claim survives whatever happens next.
--   2. Run the handler.
--   3. Record the response against the key.
--
-- A replay then has three outcomes, and all three matter:
--
--   completed   → return the ORIGINAL response, byte for byte. The caller
--                 cannot tell a retry from the first attempt, which is the
--                 entire point.
--   in_progress → 409. Two clicks genuinely raced; the second must not run.
--   failed      → the key is released, so an honest retry can proceed. A
--                 permanently-burned key on a transient DB error would be
--                 worse than no idempotency: the user could never complete
--                 the action at all.
--
-- request_hash guards key REUSE: the same key with a different body is a
-- client bug (usually a key generated once and never rotated), and silently
-- returning the first response would hide a real mistake. It 422s instead.

CREATE TABLE idempotency_keys (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Client-supplied. Scoped per tenant so keys can never collide across
  -- shops, and a key from one tenant can never surface another's response.
  key             text NOT NULL,
  -- The route that claimed it. The same key on a different route is a
  -- different operation, not a replay.
  route           text NOT NULL,
  -- SHA-256 of the request body, to catch key reuse with changed content.
  request_hash    text NOT NULL,
  status          text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed')),
  -- The stored response, replayed verbatim on a duplicate.
  response_status int,
  response_body   jsonb,
  -- Who claimed it, for support ("did that payment go through twice?").
  claimed_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (tenant_id, key, route)
);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO app_user;

-- Reaping old keys. 24h is comfortably longer than any client will retry, and
-- short enough that this never becomes a large table. Deliberately NOT a
-- unique-index-with-expiry: an expired key that gets REUSED must be treated as
-- a fresh request, not as a replay of a response the caller has long forgotten.
CREATE INDEX idempotency_keys_reap_idx ON idempotency_keys (created_at);

COMMENT ON TABLE idempotency_keys IS
  'Request-level idempotency. Claim -> work -> record, per (tenant, key, '
  'route). A completed key replays its stored response verbatim; an '
  'in-progress key 409s; a failed handler DELETES the key so an honest retry '
  'can proceed.';
