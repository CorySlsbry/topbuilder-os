-- 0000_bootstrap — extensions used across the schema.
-- Real tables, roles, and RLS policies arrive in the S1 security-spine migration.
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid(), digest()
