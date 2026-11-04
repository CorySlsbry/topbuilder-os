-- 0014: workforce — workers, WC classes, crews, and time -> burdened labor.
--
-- The point: labor on a job costs the BURDENED rate (wages + employer FICA
-- + unemployment + workers' comp by class + benefits), not the paycheck
-- number. Posting a worker-week debits 1430 with job dims at the burdened
-- amount and credits accrued wages (2400) + accrued burden (2425); the real
-- payroll run (S18, embedded provider) clears the accruals.

CREATE TABLE wc_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  class_code text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- premium in cents per $100 of wages (numerically = bps of wages)
  rate_per100_cents int NOT NULL CHECK (rate_per100_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, class_code)
);

CREATE TABLE workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  trade text NOT NULL DEFAULT '',
  user_id text, -- optional link to a login
  wc_class_code text NOT NULL,
  base_hourly_cents bigint NOT NULL CHECK (base_hourly_cents > 0),
  fica_bps int NOT NULL DEFAULT 765,
  unemployment_bps int NOT NULL DEFAULT 0,
  benefits_hourly_cents bigint NOT NULL DEFAULT 0,
  other_bps int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE crews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);

CREATE TABLE crew_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  crew_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  UNIQUE (tenant_id, crew_id, worker_id),
  FOREIGN KEY (tenant_id, crew_id) REFERENCES crews (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, worker_id) REFERENCES workers (tenant_id, id) ON DELETE CASCADE
);

-- Time entries grow a worker link + a posting lifecycle. Existing rows
-- (field-app quick capture) stay valid: worker_id nullable.
ALTER TABLE time_entries
  ADD COLUMN worker_id uuid,
  ADD COLUMN status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'posted', 'rejected')),
  ADD COLUMN journal_entry_id uuid,
  ADD COLUMN wages_cents bigint,
  ADD COLUMN burden_cents bigint,
  ADD CONSTRAINT time_entries_worker_fk
    FOREIGN KEY (tenant_id, worker_id) REFERENCES workers (tenant_id, id);

-- A posted time entry is part of the labor audit trail: locked.
CREATE OR REPLACE FUNCTION app.forbid_posted_time_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'posted time entries are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'posted time entries are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER time_entries_posted_immutable
  BEFORE UPDATE OR DELETE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION app.forbid_posted_time_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wc_classes', 'workers', 'crews', 'crew_members'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON wc_classes, workers, crews TO app_user;
GRANT SELECT, INSERT, DELETE ON crew_members TO app_user;
