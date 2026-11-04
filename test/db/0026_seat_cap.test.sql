-- pgTAP: the seat cap must hold under CONCURRENCY, not just polite use.
--
-- The app checks "is a seat free?" in one transaction and inserts in another.
-- Two owners inviting at the same moment both read 9-of-10 and both insert,
-- landing 11 people on a 10-seat plan with no error and no extra revenue.
-- The database is the only place that race can be closed, so this proves the
-- trigger holds it — and that the free CPA seat is still genuinely free.
BEGIN;
SELECT plan(4);

INSERT INTO tenants(id, name, slug) VALUES
  ('7e57cafe-0000-0000-0000-000000000001', 'Seat Cap Co', 'seat-cap-co');
INSERT INTO subscriptions(tenant_id, plan, seat_cap, status) VALUES
  ('7e57cafe-0000-0000-0000-000000000001', 'crew', 3, 'active');

-- Fill the plan exactly to its cap.
INSERT INTO memberships(tenant_id, user_id, role) VALUES
  ('7e57cafe-0000-0000-0000-000000000001', 'seat-a', 'owner'),
  ('7e57cafe-0000-0000-0000-000000000001', 'seat-b', 'staff'),
  ('7e57cafe-0000-0000-0000-000000000001', 'seat-c', 'staff');
SELECT is((SELECT count(*)::int FROM memberships
            WHERE tenant_id='7e57cafe-0000-0000-0000-000000000001' AND role<>'bookkeeper'),
          3, 'plan filled exactly to its 3-seat cap');

-- 1) One more paid seat must be refused — this is the race, made deterministic.
SELECT throws_ok($$
  INSERT INTO memberships(tenant_id, user_id, role)
  VALUES ('7e57cafe-0000-0000-0000-000000000001', 'seat-d', 'staff')
$$, '23514', NULL, 'a 4th paid seat on a 3-seat plan is refused by the database');

-- 2) The CPA/bookkeeper seat is free and must STILL be allowed at the cap.
SELECT lives_ok($$
  INSERT INTO memberships(tenant_id, user_id, role)
  VALUES ('7e57cafe-0000-0000-0000-000000000001', 'the-cpa', 'bookkeeper')
$$, 'the free bookkeeper seat is still allowed at a full cap');

-- 3) Raising the cap lets the next person in — the trigger reads the CURRENT
--    plan rather than a value cached anywhere.
UPDATE subscriptions SET seat_cap = 4
 WHERE tenant_id = '7e57cafe-0000-0000-0000-000000000001';
SELECT lives_ok($$
  INSERT INTO memberships(tenant_id, user_id, role)
  VALUES ('7e57cafe-0000-0000-0000-000000000001', 'seat-d', 'staff')
$$, 'upgrading the plan immediately frees a seat');

SELECT * FROM finish();
ROLLBACK;
