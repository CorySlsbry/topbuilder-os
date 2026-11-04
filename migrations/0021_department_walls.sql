-- 0021: department walls, operational.
--
-- The S1 spine (departments, member_department_access, app.current_departments)
-- becomes a product feature: three standard walls per tenant, per-person
-- on/off toggles managed by the owner, and enforcement on the money/HR
-- routes. Owner/admin implicitly hold every wall (resolveScope expands);
-- everyone else holds exactly what they're granted — down to a 1-person shop
-- where the owner simply holds everything.

-- Standard walls for every EXISTING tenant (new tenants get them at signup).
INSERT INTO departments (tenant_id, key, name)
SELECT t.id, d.key, d.name
  FROM tenants t
 CROSS JOIN (VALUES
   ('field', 'Field & jobs'),
   ('financials', 'Money & books'),
   ('hr', 'People & pay')
 ) AS d(key, name)
ON CONFLICT (tenant_id, key) DO NOTHING;

-- Team management writes (role changes, wall toggles) run as app_user under
-- tenant RLS; the API additionally requires owner/admin.
GRANT UPDATE ON memberships TO app_user;
GRANT INSERT ON departments TO app_user;
GRANT INSERT, DELETE ON member_department_access TO app_user;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                  WHERE polrelid = 'memberships'::regclass
                    AND polname = 'memberships_tenant_write') THEN
    CREATE POLICY memberships_tenant_write ON memberships
      FOR UPDATE
      USING (tenant_id = app.current_tenant())
      WITH CHECK (tenant_id = app.current_tenant());
  END IF;
END $$;

-- A redeemed CPA invite now also opens the Money & books wall — a
-- bookkeeper who can't see the books is a support ticket, not security.
CREATE OR REPLACE FUNCTION app.redeem_advisor_invite(p_code uuid, p_uid text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE v_tenant uuid; v_role text; v_membership uuid; v_dept uuid;
BEGIN
  SELECT tenant_id, role INTO v_tenant, v_role
    FROM advisor_invites
   WHERE code = p_code AND NOT revoked AND redeemed_by IS NULL
   FOR UPDATE;
  IF v_tenant IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO memberships (tenant_id, user_id, role)
  VALUES (v_tenant, p_uid, v_role)
  ON CONFLICT (tenant_id, user_id) DO NOTHING;
  SELECT id INTO v_membership FROM memberships
   WHERE tenant_id = v_tenant AND user_id = p_uid;
  SELECT id INTO v_dept FROM departments
   WHERE tenant_id = v_tenant AND key = 'financials';
  IF v_membership IS NOT NULL AND v_dept IS NOT NULL THEN
    INSERT INTO member_department_access (tenant_id, membership_id, department_id)
    VALUES (v_tenant, v_membership, v_dept)
    ON CONFLICT (membership_id, department_id) DO NOTHING;
  END IF;
  UPDATE advisor_invites SET redeemed_by = p_uid, redeemed_at = now()
   WHERE code = p_code;
  RETURN v_tenant;
END $$;
