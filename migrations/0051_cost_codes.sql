-- 0051_cost_codes — give the cost-code table a reason to exist.
--
-- `cost_codes` has been in the schema since 0004 and NOTHING in the product
-- ever populated it or read it. Every job cost in every shop was posted
-- against a hardcoded `4100` — in field capture, in purchasing, on the job
-- screen, and on the bank screen. The consequence is not cosmetic: the
-- by-code breakdown on the job money screen groups every cost in the
-- business into one bucket, so it says nothing, and the estimate-vs-actual
-- loop that is supposed to make the next bid better has no dimension to
-- compare on.
--
-- Cost codes are the spine of construction accounting. They are what make
-- job costing, the WIP schedule, the schedule of values and an underwriter's
-- contracts-in-progress report mean anything. This migration gives the table
-- the two columns it needs to be presentable, and the seed data lands from
-- the application (see modules/job-costing/internal/cost-code-library.ts) so
-- a shop can pick the set that matches its trade rather than inheriting a
-- residential-homebuilder chart it will never use.

-- Grouping label shown as the picker's optgroup and the report's subtotal
-- row: "01 General conditions", "23 HVAC". Nullable so a hand-typed code
-- from before this migration keeps working.
ALTER TABLE cost_codes ADD COLUMN IF NOT EXISTS division text;

-- Presentation order. Codes sort as TEXT otherwise, which puts "10-100"
-- before "01-100" only by luck of the leading zero and breaks the moment a
-- shop adds a three-digit division.
ALTER TABLE cost_codes ADD COLUMN IF NOT EXISTS sort_order int NOT NULL DEFAULT 0;

-- Where a cost on this code lands in the GL when it is NOT capitalised into
-- work-in-progress. Null means "use the platform default" (1430), which is
-- what every posting does today — so this changes no behaviour until
-- something reads it.
ALTER TABLE cost_codes ADD COLUMN IF NOT EXISTS gl_account_code text;

-- Which preset the row came from, so a shop can tell its own additions apart
-- from the seeded set, and so re-seeding can be made idempotent without
-- clobbering hand-made codes.
ALTER TABLE cost_codes ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','seed'));

ALTER TABLE cost_codes ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS cost_codes_tenant_sort_idx
  ON cost_codes(tenant_id, sort_order, code);

-- ── NO "which trade did you pick" column, deliberately ───────────────────
-- The obvious move is a settings column recording the chosen preset. There
-- is nothing for it to do: the CODES THEMSELVES ARE THE STATE. The screen
-- lists what exists and offers the presets when nothing does, a shop that
-- does HVAC and plumbing seeds both, and a shop that renames half of them
-- has a set that no preset name describes any more. A column that only ever
-- disagrees with reality is worse than no column.

-- ── proof the table is writable as the app role ──────────────────────────
DO $$
DECLARE t uuid; n int;
BEGIN
  SELECT id INTO t FROM tenants LIMIT 1;
  IF t IS NULL THEN
    RAISE NOTICE 'no tenants yet — skipping the write probe';
    RETURN;
  END IF;
  PERFORM set_config('app.current_tenant', t::text, true);

  INSERT INTO cost_codes (tenant_id, code, name, kind, division, sort_order, source)
  VALUES (t, '__probe__', 'probe', 'other', 'probe', 0, 'seed')
  ON CONFLICT (tenant_id, code) DO NOTHING;

  UPDATE cost_codes SET name = 'probe2' WHERE tenant_id = t AND code = '__probe__';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'cost_codes UPDATE matched % rows, not 1', n;
  END IF;

  -- Cleaned up as the MIGRATION role, which owns the table. Note that the
  -- app role cannot do this: 0004 grants it SELECT/INSERT/UPDATE only, so in
  -- the product a code is retired with `is_active = false`. That is the
  -- right shape anyway — deleting a code that historical job costs point at
  -- would orphan them.
  DELETE FROM cost_codes WHERE tenant_id = t AND code = '__probe__';
  RAISE NOTICE 'cost_codes is seedable and editable';
END $$;
