-- Job forms and checklists — the last completely absent feature.
--
-- ServiceTitan and Housecall Pro both ship these and a shop evaluating this
-- product asks for them by name: a startup checklist, a safety sign-off, a
-- "customer approved the work" signature at the end.
--
-- ── TEMPLATE-DRIVEN, not fixed forms ──────────────────────────────────────
-- This product already chose "fit how any company runs" when it built dynamic
-- departments. A fixed set of checklists contradicts that: an HVAC shop's
-- startup form and a roofer's tear-off form have nothing in common except
-- being a list of things somebody has to confirm.
--
-- ── ONE PUT WRITES THE WHOLE ORDERED ARRAY ────────────────────────────────
-- Items have a position, and per-item endpoints would mean two people
-- reordering at once produce an order neither of them chose — or worse, two
-- items at position 3. The template is edited as a document: the client sends
-- the full array, the server deletes and rewrites the items in one
-- transaction, and `position` is assigned from the array index. There is no
-- ordering race because there is no partial order to race on.
--
-- ── FILLING is per item, because the roof has two bars ────────────────────
-- The opposite choice for the OTHER direction. A tech ticking boxes on a roof
-- with bad signal must not lose the whole form because the last save failed,
-- so answers save one at a time through the existing outbox. Editing a
-- template happens at a desk; filling one happens in the weather.

CREATE TABLE form_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- What this form is FOR. Free text on purpose: "roof tear-off startup" is a
  -- better label than anything an enum of ours would have guessed.
  description text NOT NULL DEFAULT '',
  -- An archived template stops being offered but keeps every form already
  -- filled from it. Deleting would erase a signed record.
  archived    boolean NOT NULL DEFAULT false,
  /**
   * Does a job need this form finished before it can be marked complete?
   *
   * Off by default and inert until the tenant switches the gate on — see
   * job_form_settings below. The flag lives here rather than on the setting so
   * a shop can require the safety sign-off without requiring the optional
   * post-job photo log.
   */
  required_for_completion boolean NOT NULL DEFAULT false,
  created_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- The composite-FK target the item table below points at. Declared HERE
  -- rather than added afterwards: Postgres resolves a composite foreign key
  -- against constraints that already exist, so a later ALTER is too late.
  UNIQUE (tenant_id, id)
);
ALTER TABLE form_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON form_templates
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON form_templates TO app_user;

CREATE TABLE form_template_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id uuid NOT NULL,
  -- Assigned from the array index by the PUT. Never sent by the client.
  position    int NOT NULL,
  kind        text NOT NULL
              CHECK (kind IN ('check','text','number','photo','signature')),
  label       text NOT NULL,
  -- Shown under the label. Where a shop puts "torque to 45 ft-lbs".
  hint        text NOT NULL DEFAULT '',
  required    boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, template_id, position),
  FOREIGN KEY (tenant_id, template_id) REFERENCES form_templates (tenant_id, id)
    ON DELETE CASCADE
);
ALTER TABLE form_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_template_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON form_template_items
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON form_template_items TO app_user;
CREATE INDEX form_template_items_order ON form_template_items (tenant_id, template_id, position);

-- ── a form actually filled in on a job ───────────────────────────────────
CREATE TABLE job_forms (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id       uuid NOT NULL,
  template_id  uuid NOT NULL,
  -- COPIED from the template at attach time. A template renamed next year must
  -- not silently retitle a form somebody signed last year.
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','complete')),
  completed_at timestamptz,
  completed_by text NOT NULL DEFAULT '',
  created_by   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- One of each template per job. A second "safety sign-off" on the same job
  -- is a mistake every time, and the UNIQUE says so before the data does.
  UNIQUE (tenant_id, job_id, template_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT completed_needs_a_person CHECK (
    status <> 'complete' OR (completed_at IS NOT NULL AND completed_by <> '')
  )
);
ALTER TABLE job_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_forms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_forms
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON job_forms TO app_user;
CREATE INDEX job_forms_by_job ON job_forms (tenant_id, job_id);

CREATE TABLE job_form_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  form_id      uuid NOT NULL,
  position     int NOT NULL,
  -- SNAPSHOT of the template item. The template can change tomorrow; what a
  -- person was asked, and answered, must not.
  kind         text NOT NULL
               CHECK (kind IN ('check','text','number','photo','signature')),
  label        text NOT NULL,
  hint         text NOT NULL DEFAULT '',
  required     boolean NOT NULL DEFAULT false,
  -- The answer, by kind. Only one is ever populated:
  --   check     -> checked
  --   text      -> value_text
  --   number    -> value_number
  --   photo     -> attachment_id (the existing job-attachment pipeline)
  --   signature -> attachment_id (a PNG) and/or signed_name (typed fallback)
  checked      boolean,
  value_text   text NOT NULL DEFAULT '',
  value_number numeric(14,4),
  attachment_id uuid,
  signed_name  text NOT NULL DEFAULT '',
  answered_by  text NOT NULL DEFAULT '',
  answered_at  timestamptz,
  UNIQUE (tenant_id, form_id, position),
  FOREIGN KEY (tenant_id, form_id) REFERENCES job_forms (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE job_form_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_form_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_form_items
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON job_form_items TO app_user;
CREATE INDEX job_form_items_order ON job_form_items (tenant_id, form_id, position);

-- ── the completion gate, off by default ──────────────────────────────────
--
-- ⛔ THIS IS THE PART THAT CAN BREAK A SHOP'S DAY, so it ships switched off.
--
-- `POST /api/jobs/[id]/status` currently allows any status to any status with
-- no guard at all. Turning this on makes "you can't mark this job complete
-- until the safety form is signed" real — which is the point, and also exactly
-- the kind of rule that strands a crew at 6pm on a Friday if it arrives
-- without anybody choosing it.
CREATE TABLE job_form_settings (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- OFF. A shop turns this on once its templates are actually in use.
  gate_completion boolean NOT NULL DEFAULT false,
  updated_by      text NOT NULL DEFAULT '',
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE job_form_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_form_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_form_settings
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON job_form_settings TO app_user;

-- Prove the policies admit a write rather than assuming the GRANT was enough.
-- A table an app can read but not write is a form that silently does nothing.
DO $$
DECLARE
  t uuid;
  tpl uuid;
  n int;
BEGIN
  SELECT id INTO t FROM tenants ORDER BY created_at LIMIT 1;
  IF t IS NULL THEN
    RAISE NOTICE 'no tenants yet — skipping the write probe';
    RETURN;
  END IF;
  PERFORM set_config('app.current_tenant', t::text, true);

  INSERT INTO form_templates (tenant_id, name) VALUES (t, '__probe__') RETURNING id INTO tpl;
  INSERT INTO form_template_items (tenant_id, template_id, position, kind, label)
    VALUES (t, tpl, 0, 'check', 'probe item');
  UPDATE form_templates SET description = 'x' WHERE id = tpl;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'form_templates UPDATE matched % rows, not 1', n;
  END IF;

  INSERT INTO job_form_settings (tenant_id) VALUES (t) ON CONFLICT DO NOTHING;
  UPDATE job_form_settings SET gate_completion = false WHERE tenant_id = t;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'job_form_settings UPDATE matched % rows, not 1', n;
  END IF;

  DELETE FROM form_templates WHERE id = tpl;
  RAISE NOTICE 'job-form tables are readable and writable';
END $$;
