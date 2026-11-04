-- 0005_attachments — receipt photos and job documents.
-- Bytes live in object storage (local disk in dev, GCS in prod); this table
-- holds the metadata + the storage key. Tenant-scoped keys mean a signed URL
-- can never be minted for another tenant's object.
CREATE TABLE job_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id        uuid NOT NULL,
  cost_entry_id uuid,
  kind          text NOT NULL DEFAULT 'receipt'
                CHECK (kind IN ('receipt','photo','document')),
  storage_key   text NOT NULL,           -- tenants/<tenant>/jobs/<job>/<uuid>.<ext>
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  original_name text,
  uploaded_by   text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id)
);
CREATE INDEX ja_tenant_job_idx ON job_attachments(tenant_id, job_id);
ALTER TABLE job_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_attachments FORCE  ROW LEVEL SECURITY;
CREATE POLICY ja_tenant ON job_attachments
  USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

GRANT SELECT, INSERT ON job_attachments TO app_user;
