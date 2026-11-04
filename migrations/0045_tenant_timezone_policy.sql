-- Changing your timezone silently did nothing.
--
-- Migration 0042 added `tenants.timezone`, a validation trigger, and
-- `GRANT UPDATE (timezone) ON tenants TO app_user`. All correct, and all
-- useless: `tenants` carries exactly one RLS policy, `tenants_member_read`,
-- and it is `FOR SELECT`. A policy set that has no UPDATE policy does not
-- allow updates — it silently matches zero rows.
--
-- So the settings screen accepted a new timezone, the API returned 200 with
-- the row it read back, and nothing had changed. Worse, the validation trigger
-- never fired either, so an INVALID zone also returned 200 — which is how the
-- endpoint sweep caught this: it asserted a 422 for "Mars/Olympus" and got a
-- cheerful 200 instead.
--
-- This is the WRITE form of the law that has already cost this build four
-- outages on the read side. Absent scope does not error, it returns nothing;
-- absent policy does not error, it changes nothing. A grant is permission to
-- attempt, not permission to succeed — on an RLS table you need both, and the
-- failure is silent in each direction.
--
-- ── Why a policy rather than a definer function ───────────────────────────
-- The alternative was `app.set_tenant_timezone()` as SECURITY DEFINER. A
-- policy is better here because the protection is already layered and each
-- layer is independently readable:
--   * the COLUMN grant means app_user can only ever touch `timezone` — it
--     cannot rename the shop or change its slug;
--   * this policy means it can only touch its OWN tenant's row;
--   * the route requires owner/admin;
--   * the trigger from 0042 rejects a zone the tz database does not know.
-- A definer function would collapse those into one place and make the column
-- grant decorative.
CREATE POLICY tenants_member_update ON tenants
  FOR UPDATE
  USING (id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

COMMENT ON POLICY tenants_member_update ON tenants IS
  'Lets a tenant update its OWN row. Paired with a column-level GRANT that '
  'limits app_user to `timezone` — the policy scopes WHICH row, the grant '
  'scopes WHICH column. Without this policy the update silently affected zero '
  'rows and reported success (migration 0045).';
