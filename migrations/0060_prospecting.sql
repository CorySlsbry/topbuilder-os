-- 0060 — prospecting: coordinates on the book, opportunities, stage history.
--
-- Part B1 of the sales-with-maps plan (Cory 2026-08-13). ServiceTitan's
-- version of this screen runs on data they ACQUIRED (Convex: 64M properties,
-- 146M contacts). Ours starts from the book the shop already owns — every
-- customer and property gets coordinates, and an opportunity pipeline hangs
-- off customers that already exist. No licensed data, no invented contacts.
--
-- ── coordinates ──────────────────────────────────────────────────────────
-- Plain lat/lng doubles, NOT PostGIS: the queries this product needs are
-- "pins inside the viewport" and "rough distance", both fine with doubles
-- and a b-tree. An extension is a dependency the next migration inherits
-- forever; it earns its way in when a real spatial query does.
--
-- geocode_status is the honest ledger of what happened:
--   pending — has an address nobody has tried yet
--   ok      — geocoder returned coordinates (lat/lng set)
--   failed  — geocoder tried and could not resolve it (fictional demo
--             addresses land here, correctly)
--   manual  — a human dropped the pin; the geocoder must never overwrite it
--   skipped — no address to geocode. NOT 'failed': failed means tried.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS lat double precision,
  ADD COLUMN IF NOT EXISTS lng double precision,
  ADD COLUMN IF NOT EXISTS geocode_status text NOT NULL DEFAULT 'pending'
    CHECK (geocode_status IN ('pending','ok','failed','manual','skipped')),
  ADD COLUMN IF NOT EXISTS geocoded_at timestamptz;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS lat double precision,
  ADD COLUMN IF NOT EXISTS lng double precision,
  ADD COLUMN IF NOT EXISTS geocode_status text NOT NULL DEFAULT 'pending'
    CHECK (geocode_status IN ('pending','ok','failed','manual','skipped')),
  ADD COLUMN IF NOT EXISTS geocoded_at timestamptz;

-- Coordinates must arrive as a pair or not at all. Half a coordinate is a
-- pin on the equator or the prime meridian, silently wrong on a map.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_latlng_pair;
ALTER TABLE customers ADD CONSTRAINT customers_latlng_pair
  CHECK ((lat IS NULL) = (lng IS NULL));
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_latlng_pair;
ALTER TABLE properties ADD CONSTRAINT properties_latlng_pair
  CHECK ((lat IS NULL) = (lng IS NULL));

-- ⛔ Backfill runs PER TENANT with the GUC set — a set-based UPDATE as
-- `postgres` updates ZERO rows under FORCE RLS on this instance (0054's
-- silent-noop lesson; the loop is the 0037/0057 idiom).
DO $$
DECLARE t record; n_cust int := 0; n_prop int := 0; c int;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);
    UPDATE customers SET geocode_status = 'skipped'
     WHERE COALESCE(TRIM(address), '') = '' AND geocode_status = 'pending';
    GET DIAGNOSTICS c = ROW_COUNT; n_cust := n_cust + c;
    UPDATE properties SET geocode_status = 'skipped'
     WHERE COALESCE(TRIM(address), '') = '' AND geocode_status = 'pending';
    GET DIAGNOSTICS c = ROW_COUNT; n_prop := n_prop + c;
  END LOOP;
  RAISE NOTICE 'address-less rows marked skipped: % customers, % properties', n_cust, n_prop;
END $$;

-- ── opportunities ────────────────────────────────────────────────────────
-- customer_id is NOT NULL on purpose, tighter than the sketch: in own-book
-- mode every opportunity starts from someone already in the book, and an
-- orphan "prospect" row with no contact information is exactly the entity
-- this phase decided NOT to invent. Loosening later is one ALTER, tightening
-- later is a data migration.
CREATE TABLE opportunities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL,
  property_id   uuid,
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  stage         text NOT NULL DEFAULT 'new'
                CHECK (stage IN ('new','qualify','propose','follow_up','won','lost')),
  value_cents   bigint NOT NULL DEFAULT 0 CHECK (value_cents >= 0),
  source        text NOT NULL DEFAULT 'manual'
                CHECK (source IN ('manual','signal','map','estimate')),
  owner_uid     text NOT NULL DEFAULT '',
  next_task     text NOT NULL DEFAULT '',
  next_task_due date,
  -- a lost deal without a reason teaches nothing; enforced at the module
  -- layer (422 before the UPDATE) so the message is human, but backstopped
  -- here so no future writer can forget.
  lost_reason   text NOT NULL DEFAULT '',
  converted_job_id uuid,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  FOREIGN KEY (tenant_id, converted_job_id) REFERENCES jobs (tenant_id, id),
  CONSTRAINT lost_needs_reason CHECK (stage <> 'lost' OR length(lost_reason) > 0)
);
CREATE INDEX opp_tenant_stage ON opportunities (tenant_id, stage);
CREATE INDEX opp_tenant_customer ON opportunities (tenant_id, customer_id);

ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON opportunities
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON opportunities TO app_user;

-- Append-only stage history — the contract-movements idiom. Days-in-stage
-- and per-stage aging come from HERE, never from a mutable column, so the
-- pipeline math cannot drift from what actually happened.
CREATE TABLE opportunity_stage_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL,
  stage          text NOT NULL
                 CHECK (stage IN ('new','qualify','propose','follow_up','won','lost')),
  at             timestamptz NOT NULL DEFAULT now(),
  by             text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, id)
);
CREATE INDEX ose_tenant_opp ON opportunity_stage_events (tenant_id, opportunity_id, at);

ALTER TABLE opportunity_stage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_stage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON opportunity_stage_events
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
-- append-only: no UPDATE grant, same posture as journal_lines
GRANT SELECT, INSERT ON opportunity_stage_events TO app_user;

-- Target dispositions (B2 reads these; created now so B2 is code-only).
CREATE TABLE target_dispositions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id  uuid NOT NULL,
  signal_key   text NOT NULL,   -- e.g. 'equipment-aging:<equipment_id>'
  disposition  text NOT NULL CHECK (disposition IN ('dismissed','snoozed')),
  until        date,            -- snoozes expire; dismissals have NULL
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, customer_id, signal_key),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
ALTER TABLE target_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_dispositions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON target_dispositions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON target_dispositions TO app_user;

-- ── proof: behaviour, not DDL (0058/0059 discipline) ─────────────────────
-- Exercised with real writes inside self-rolling-back blocks, on the first
-- tenant that has a customer. Early return RAISES A NOTICE saying nothing
-- was exercised (0059's vacuous-pass lesson).
DO $$
DECLARE
  t_id uuid; c_id uuid; o_id uuid; other uuid;
  visible int; ok boolean := false;
BEGIN
  SELECT t.id INTO t_id FROM tenants t ORDER BY created_at LIMIT 1;
  IF t_id IS NULL THEN
    RAISE NOTICE 'no tenants; schema landed but NOT exercised'; RETURN;
  END IF;
  PERFORM set_config('app.current_tenant', t_id::text, true);
  SELECT id INTO c_id FROM customers LIMIT 1;
  IF c_id IS NULL THEN
    RAISE NOTICE 'tenant % has no customers; schema landed but NOT exercised', t_id; RETURN;
  END IF;

  -- 1. a lost opportunity without a reason must be REJECTED
  BEGIN
    INSERT INTO opportunities (tenant_id, customer_id, title, stage, created_by)
    VALUES (t_id, c_id, 'probe', 'lost', 'probe');
    RAISE EXCEPTION 'lost_needs_reason did not bind';
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'probe 1 proved nothing'; END IF;

  -- 2. half a coordinate must be rejected
  ok := false;
  BEGIN
    UPDATE customers SET lat = 33.4, lng = NULL WHERE id = c_id;
    RAISE EXCEPTION 'latlng_pair did not bind';
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'probe 2 proved nothing'; END IF;

  -- 3. cross-tenant blindness: a second tenant must see zero of a real row
  BEGIN
    INSERT INTO opportunities (tenant_id, customer_id, title, created_by)
    VALUES (t_id, c_id, 'probe isolation', 'probe') RETURNING id INTO o_id;
    SELECT id INTO other FROM tenants WHERE id <> t_id LIMIT 1;
    IF other IS NOT NULL THEN
      PERFORM set_config('app.current_tenant', other::text, true);
      SELECT count(*) INTO visible FROM opportunities WHERE id = o_id;
      PERFORM set_config('app.current_tenant', t_id::text, true);
      IF visible <> 0 THEN RAISE EXCEPTION 'RLS LEAK: tenant % saw the row', other; END IF;
    ELSE
      RAISE NOTICE 'single tenant db; isolation not exercised here';
    END IF;
    RAISE EXCEPTION 'PROBE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'PROBE_ROLLBACK' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'prospecting probes: lost-reason binds, latlng pairs bind, RLS blind across tenants';
END $$;
