-- 0007 — views must run with the CALLER's rights, not the owner's.
--
-- A plain CREATE VIEW executes with its owner's privileges (the migration
-- superuser) — which BYPASSES row-level security on the base tables. That
-- made pending_depreciation_nudges a cross-tenant leak: any tenant could see
-- every tenant's completed insurance jobs. security_invoker makes the view
-- run as the querying role, so RLS applies exactly as it does on the tables.
-- (Caught by pgTAP the moment a second tenant had real data.)
ALTER VIEW pending_depreciation_nudges SET (security_invoker = true);
