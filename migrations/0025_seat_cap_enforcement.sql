-- Seat cap must hold under CONCURRENCY, not just under polite sequential use.
--
-- assertSeatAvailable() reads the count in one transaction and addMember()
-- inserts in another, with no lock between them. Two owners inviting at the
-- same moment both read "9 of 10 used", both pass, and the tenant lands on 11
-- seats of a 10-seat plan — silently, with no error and no extra revenue.
-- That is a check-then-act race, and the only place it can be closed for good
-- is the database, the same reasoning that put tenant isolation in RLS and the
-- balanced-entry rule in a constraint trigger rather than in application code.
--
-- The app-layer check stays: it produces the friendly "7 of your 10 spots are
-- open" message. This is the backstop that makes the guarantee true.

CREATE OR REPLACE FUNCTION app.enforce_seat_cap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  v_cap   int;
  v_used  int;
BEGIN
  -- The CPA/bookkeeper seat is free and never counts against the cap.
  IF NEW.role = 'bookkeeper' THEN
    RETURN NEW;
  END IF;

  -- Lock the tenant's subscription row so concurrent inserts serialise here.
  -- No subscription row yet (a tenant mid-signup, or a fixture) means there is
  -- no cap to enforce — the trial row is created moments later by signup().
  SELECT seat_cap INTO v_cap
    FROM subscriptions
   WHERE tenant_id = NEW.tenant_id
   FOR UPDATE;

  IF v_cap IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_used
    FROM memberships
   WHERE tenant_id = NEW.tenant_id
     AND role <> 'bookkeeper';

  IF v_used >= v_cap THEN
    RAISE EXCEPTION 'seat_limit_reached: % of % seats already used', v_used, v_cap
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

-- BEFORE INSERT only: an existing member changing role is handled by the app,
-- and we never want a role edit to lock someone out of their own tenant.
DROP TRIGGER IF EXISTS memberships_seat_cap ON memberships;
CREATE TRIGGER memberships_seat_cap
  BEFORE INSERT ON memberships
  FOR EACH ROW EXECUTE FUNCTION app.enforce_seat_cap();

-- ---------------------------------------------------------------------------
-- Stripe does NOT guarantee webhook ordering. Retries and concurrent delivery
-- can hand us an OLDER customer.subscription.updated after a NEWER one, and
-- the handler would faithfully apply it — rolling a tenant back to a stale
-- plan or re-marking a paid account past_due. Dedupe on event.id does not help:
-- these are two DIFFERENT events, each valid, neither a replay.
--
-- Record the Stripe event clock we last applied, so a late arrival can be
-- recognised as stale and skipped.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS last_event_at timestamptz;

COMMENT ON COLUMN subscriptions.last_event_at IS
  'created timestamp of the newest Stripe event applied to this row; guards against out-of-order webhook delivery';
