-- Dynamic departments (Cory 2026-08-03): "the platform is dynamic and will
-- fit how any company runs."
--
-- The schema has been general since 0001 — departments is (tenant_id, key,
-- name) with many-to-many member grants — but the API hardcoded the three
-- standard keys and app_user could only INSERT (0021 granted it for
-- signup-time seeding). An owner can now create, rename, and delete custom
-- departments (install-crews, service, sales, warehouse...) and grant any mix
-- of them to any person.
--
-- The standard three (field / financials / hr) remain ENFORCEMENT keys: routes,
-- agent kinds, and the 0029 RESTRICTIVE policies gate on them by name. The app
-- layer refuses to delete them (department_protected) and refuses to delete
-- any department that still has members granted (department_in_use) — an org
-- chart cleanup must not strip access as a side effect.
--
-- Custom keys flow into scope.departments and app.current_departments exactly
-- like the standard ones, so anything that later gates on them — a route
-- requirement, an RLS policy via app.can_see_department('sales') — works with
-- no further plumbing.

GRANT UPDATE, DELETE ON departments TO app_user;

-- member_department_access already carries SELECT/INSERT/DELETE for app_user
-- (setMemberDepartments rewrites grants); nothing to widen there.
