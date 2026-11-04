-- Online self-booking: a homeowner picks their own slot from a public page.
--
-- Housecall Pro's biggest lead lever, and the one thing a shop evaluating this
-- product will try to do in the first five minutes. The scheduling engine
-- already exists (real capacity: active workers × windows − booked); what is
-- missing is a public door onto it, a per-shop switch, and — the part that
-- actually matters — serialization.
--
-- ── The race is real, not theoretical ────────────────────────────────────
-- `bookIntakeTx` inserts an appointment unconditionally. There is no unique
-- index, no exclusion constraint, and no capacity check at execution time:
-- availability is computed when the slots are DISPLAYED. With staff booking,
-- two people taking the last Tuesday-afternoon slot at the same moment is a
-- rare annoyance someone notices. With a public page it is Saturday morning
-- and two strangers, and the shop finds out by driving to one of them.
--
-- The fix is a transaction-scoped ADVISORY LOCK on (tenant, date, window) plus
-- a re-count inside the same transaction. Deliberately not a unique index:
-- capacity is N per window, not 1, and N moves when a worker is hired or
-- deactivated — that is a counting problem, not a uniqueness problem. And
-- deliberately not SERIALIZABLE: it would make every unrelated booking in the
-- system contend, to solve a collision that is scoped to one half-day.

CREATE TABLE booking_settings (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- OFF by default. A shop must decide to put a booking form on the internet;
  -- switching it on for them because we built it is not our call to make.
  enabled       boolean NOT NULL DEFAULT false,
  -- How far ahead a customer may book. 14 business days is a fortnight of
  -- real calendar without offering a slot nobody can staff.
  days_out      int NOT NULL DEFAULT 14 CHECK (days_out BETWEEN 1 AND 60),
  -- Don't offer a window starting inside this many hours. The slot engine
  -- already never offers today; this is the shop's own "we need notice".
  min_lead_hours int NOT NULL DEFAULT 12 CHECK (min_lead_hours BETWEEN 0 AND 168),
  -- Shown under the heading on the public page. The shop's own words.
  intro         text NOT NULL DEFAULT '',
  updated_by    text NOT NULL DEFAULT '',
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ⛔ ENABLE-only, NEVER FORCE — and this is a deliberate application of the
-- law migration 0041 exists to enforce. The public booking page reads this
-- through a SECURITY DEFINER function BEFORE any session exists, so a FORCE
-- policy would match nothing, the lookup would return NULL, and every shop's
-- booking page would silently claim booking is switched off. That is exactly
-- how the portal, the CPA channel and the billing webhook were broken.
-- src/modules/auth-tenancy/internal/resolution-rls.test.ts holds the line.
ALTER TABLE booking_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON booking_settings
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON booking_settings TO app_user;

-- ── What the customer asked for ───────────────────────────────────────────
-- The slot a customer PICKED, kept distinct from the slot the shop later
-- books. They are usually the same and occasionally not (a dispatcher moves
-- it), and collapsing them loses the fact that the customer chose a time.
ALTER TABLE intake_requests ADD COLUMN IF NOT EXISTS requested_starts_at timestamptz;
ALTER TABLE intake_requests ADD COLUMN IF NOT EXISTS requested_ends_at   timestamptz;

-- ── The public profile, now with booking config ───────────────────────────
-- Replaces the 0042 version. Everything the unauthenticated page needs, and
-- nothing else: who the shop is, what clock it runs on, and whether it takes
-- bookings online. A tenant with no settings row reads as DISABLED via the
-- COALESCE — fail closed, so a shop cannot be opted in by our omission.
--
-- DROP first: `CREATE OR REPLACE` cannot change a function's RETURN TYPE, and
-- this one gains four columns. Replacing in place fails with
-- "cannot change return type of existing function", which rolls the whole
-- migration back — correctly, but only after you have read the error.
DROP FUNCTION IF EXISTS app.tenant_booking_profile(text);
CREATE FUNCTION app.tenant_booking_profile(p_slug text)
RETURNS TABLE (
  tenant_id uuid,
  tenant_name text,
  timezone text,
  enabled boolean,
  days_out int,
  min_lead_hours int,
  intro text
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, app
AS $$
  SELECT t.id, t.name, t.timezone,
         COALESCE(b.enabled, false),
         COALESCE(b.days_out, 14),
         COALESCE(b.min_lead_hours, 12),
         COALESCE(b.intro, '')
    FROM tenants t
    LEFT JOIN booking_settings b ON b.tenant_id = t.id
   WHERE t.slug = p_slug
$$;
REVOKE ALL ON FUNCTION app.tenant_booking_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_booking_profile(text) TO app_user;

-- ── The serialization primitive ───────────────────────────────────────────
-- A stable 64-bit key for one (tenant, date, window). hashtextextended is
-- deterministic across sessions and machines, which a plain hashtext pair is
-- not guaranteed to be at 32 bits once you concatenate.
--
-- Transaction-scoped: released at COMMIT or ROLLBACK, so a crashed booking
-- cannot wedge a shop's Tuesday afternoon forever.
CREATE OR REPLACE FUNCTION app.lock_slot(p_tenant uuid, p_date date, p_window text)
RETURNS void
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(
    hashtextextended(p_tenant::text || '|' || p_date::text || '|' || p_window, 0)
  )
$$;
REVOKE ALL ON FUNCTION app.lock_slot(uuid, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_slot(uuid, date, text) TO app_user;

-- Turn it on for the demo shop: the public booking page is the single most
-- effective thing a visitor can be shown, and a demo with it switched off
-- would be demonstrating the wrong product.
INSERT INTO booking_settings (tenant_id, enabled, intro, updated_by)
SELECT id, true,
       'Pick a time that works and we will confirm by text. Same-day emergencies, call us.',
       'migration:0044'
  FROM tenants WHERE slug = 'desert-aire'
ON CONFLICT (tenant_id) DO UPDATE SET enabled = true;

COMMENT ON TABLE booking_settings IS
  'Per-shop online-booking config. ENABLE-only RLS, never FORCE: the public '
  'booking page reads it through app.tenant_booking_profile() before any '
  'session exists. See migration 0041 for why that is load-bearing.';
COMMENT ON FUNCTION app.lock_slot(uuid, date, text) IS
  'Transaction-scoped advisory lock over one (tenant, date, am|pm) window, so '
  'two customers cannot take the same last slot. Capacity is N per window and '
  'N changes with headcount, so this is a counting problem, not a uniqueness '
  'one — hence a lock rather than a unique index.';
