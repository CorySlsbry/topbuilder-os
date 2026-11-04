-- Server-side session revocation.
--
-- The session cookie is stateless and self-contained (iron-session): it proves
-- who you are by decrypting, and nothing consults the server about whether it
-- should still be honoured. So `logout()` only deleted the CLIENT's copy. A
-- stolen sealed cookie stayed valid for its full lifetime, and disabling or
-- deleting the account in Identity Platform had NO effect on a session already
-- issued — the one control an operator reaches for in an incident did nothing.
--
-- (Removing a MEMBERSHIP always worked, because scope is re-resolved from the
-- directory on every request. That part of the design was right. This closes
-- the identity half.)
--
-- The fix is one integer per user. The cookie carries the epoch it was minted
-- at; a request is honoured only while the two still agree. Bumping the row
-- invalidates every session that user holds, everywhere, immediately.
--
-- Cost is one indexed lookup, folded into the transaction resolveScope already
-- opens — no extra round trip on the hot path.

CREATE TABLE user_session_epochs (
  user_id    text PRIMARY KEY,
  epoch      integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A directory table, like tenants/memberships: it must be readable BEFORE a
-- tenant scope exists, because it gates authentication itself. ENABLE without
-- FORCE, and the policy pins every row to the requesting principal — a user
-- can see and bump their own epoch, never anyone else's.
ALTER TABLE user_session_epochs ENABLE ROW LEVEL SECURITY;

CREATE POLICY own_epoch ON user_session_epochs
  USING (user_id = NULLIF(current_setting('app.current_uid', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.current_uid', true), ''));

GRANT SELECT, INSERT, UPDATE ON user_session_epochs TO app_user;

COMMENT ON TABLE user_session_epochs IS
  'Server-side session revocation. A session cookie carries the epoch it was '
  'minted at; requireAuth honours it only while they match. Bump to sign a '
  'user out of every device at once.';
