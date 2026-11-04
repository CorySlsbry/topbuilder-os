-- Every appointment this system has ever created is in the wrong hour.
--
-- `computeOpenSlots` emits "08:00Z" and "13:00Z" as the morning and afternoon
-- windows. `openSlots` buckets existing appointments with
-- `EXTRACT(hour FROM starts_at AT TIME ZONE 'UTC')`. Weekends are detected with
-- `getUTCDay()`. There is no timezone anywhere in the schema, so all of it is
-- UTC by accident rather than by decision.
--
-- For a Phoenix shop (UTC-7, no DST) that means "morning" is 1am local and
-- "afternoon" is 6am local. It has been survivable only because every booking
-- so far was made by a person who then read the time back on a screen and
-- fixed it in their head. The moment a CUSTOMER picks a slot themselves —
-- which is the next feature — it becomes a wrong promise to a homeowner.
--
-- ── Why the column lives on `tenants` ─────────────────────────────────────
-- The public booking page must know the shop's timezone BEFORE any session
-- exists, so whatever holds it has to be readable by a SECURITY DEFINER
-- function with no tenant GUC set. `tenants` is ENABLE-only RLS (never FORCE)
-- for exactly that reason and already carries the slug the same lookup keys
-- on. Putting the timezone in a new FORCE-scoped settings table would have
-- rebuilt, in a fresh place, the bug migration 0041 just spent a day removing
-- from three others.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone text NOT NULL
  DEFAULT 'America/Phoenix';

-- A CHECK cannot consult pg_timezone_names, and an invalid zone must not be
-- storable — `now() AT TIME ZONE <bad>` throws at READ time, which would turn
-- a typo in settings into a 500 on the booking page. Validate on write.
CREATE OR REPLACE FUNCTION app.assert_valid_timezone() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.timezone IS NULL OR NEW.timezone = '' THEN
    RAISE EXCEPTION 'timezone required';
  END IF;
  -- Throws 'time zone "x" not recognized' if the name is not in the tz
  -- database. Cheap, and it fails at the write instead of at every read.
  PERFORM now() AT TIME ZONE NEW.timezone;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS tenants_valid_timezone ON tenants;
CREATE TRIGGER tenants_valid_timezone
  BEFORE INSERT OR UPDATE OF timezone ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.assert_valid_timezone();

GRANT UPDATE (timezone) ON tenants TO app_user;

-- The demo shop is in Phoenix and says so on every screen; make it true in the
-- data rather than true by coincidence with the default.
UPDATE tenants SET timezone = 'America/Phoenix' WHERE slug = 'desert-aire';

-- ── The public booking profile ────────────────────────────────────────────
-- One definer lookup for everything the unauthenticated booking page needs:
-- who the shop is, and what clock it runs on. Returns ONLY those fields — the
-- slug is already public (it is in the shop's own booking URL) and the name is
-- what the page has to display, so nothing here is a disclosure.
--
-- Deliberately separate from app.tenant_id_by_slug rather than replacing it:
-- that function has four callers and returning a row type instead of a uuid
-- would touch all of them for no benefit.
CREATE OR REPLACE FUNCTION app.tenant_booking_profile(p_slug text)
RETURNS TABLE (tenant_id uuid, tenant_name text, timezone text)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, app
AS $$
  SELECT t.id, t.name, t.timezone FROM tenants t WHERE t.slug = p_slug
$$;
REVOKE ALL ON FUNCTION app.tenant_booking_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_booking_profile(text) TO app_user;

COMMENT ON COLUMN tenants.timezone IS
  'IANA zone the shop schedules in. Appointment windows and weekend detection '
  'resolve against it. Lives on tenants (ENABLE-only RLS) so the public '
  'booking page can read it through a definer function before any session '
  'exists — see migration 0041 for why that placement is load-bearing.';
