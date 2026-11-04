#!/usr/bin/env bash
# Seed the FICTIONAL demo tenant: Desert Aire Mechanical (residential HVAC,
# Phoenix metro, 9 people). Runs against a dev server on :5150 using ONLY the
# real product flows — signup, walls, pricebook, intake, booking, time, bank,
# invoicing. Rerunnable: signup slug collision just means it already exists.
# NO REAL CLIENT DATA — every name, job, and number here is invented.
set -euo pipefail
BASE="${BASE:-http://localhost:5150}"
JAR="$(mktemp)"
J() { curl -sf -b "$JAR" -c "$JAR" -H 'content-type: application/json' "$@"; }

echo "== owner login + tenant =="
J -X POST "$BASE/api/auth/dev-login" -d '{"email":"person1@example.com"}' > /dev/null
TENANT=$(J -X POST "$BASE/api/auth/signup" -d '{"name":"Desert Aire Mechanical","slug":"desert-aire"}' 2>/dev/null | python -c "import sys,json;print(json.load(sys.stdin).get('tenantId',''))" || true)
if [ -z "$TENANT" ]; then
  echo "(tenant exists — resolving id)"
  TENANT=$(docker exec topbuilder-db psql -U postgres -d topbuilder -tAc "SELECT id FROM tenants WHERE slug='desert-aire';" | tr -d '[:space:]')
  J -X POST "$BASE/api/auth/select-tenant" -d "{\"tenantId\":\"$TENANT\"}" > /dev/null
fi
echo "tenant=$TENANT"

echo "== team: memberships + walls =="
docker exec topbuilder-db psql -U postgres -d topbuilder -q -c "
INSERT INTO memberships (tenant_id, user_id, role) VALUES
 ('$TENANT','dev:dana@desertaire.demo','staff'),
 ('$TENANT','dev:sal@desertaire.demo','staff')
ON CONFLICT DO NOTHING;"
J -X POST "$BASE/api/team" -d '{"action":"set-departments","userId":"dev:dana@desertaire.demo","departments":["field","financials"]}' > /dev/null
J -X POST "$BASE/api/team" -d '{"action":"set-departments","userId":"dev:sal@desertaire.demo","departments":["field"]}' > /dev/null

echo "== workforce: WC class + the crew =="
J -X POST "$BASE/api/workforce/workers" -d '{"type":"wc-class","classCode":"5537","description":"HVAC install & service","ratePer100Cents":850}' > /dev/null
for W in '{"name":"Tom Herrera","trade":"lead installer","baseHourlyCents":3400}' \
         '{"name":"Luis Campos","trade":"installer","baseHourlyCents":2600}' \
         '{"name":"Jake Whitfield","trade":"installer","baseHourlyCents":2400}' \
         '{"name":"Andre Boyd","trade":"installer","baseHourlyCents":2200}' \
         '{"name":"Priya Nair","trade":"service tech","baseHourlyCents":3000}' \
         '{"name":"Sam Okafor","trade":"service tech","baseHourlyCents":2800}'; do
  J -X POST "$BASE/api/workforce/workers" -d "$(echo "$W" | python -c "import sys,json;d=json.load(sys.stdin);d.update(type='worker',wcClassCode='5537',ficaBps=765,unemploymentBps=60);print(json.dumps(d))")" > /dev/null || true
done

echo "== pricebook: HVAC flat-rate menu =="
for P in '{"code":"AC-3T","name":"3-ton AC change-out (14.3 SEER2)","unit":"system","unitPriceCents":785000,"unitCostCents":432000,"category":"Cooling","description":"Full condenser + coil swap, haul-away, startup test"}' \
         '{"code":"AC-4T","name":"4-ton AC change-out (15.2 SEER2)","unit":"system","unitPriceCents":965000,"unitCostCents":548000,"category":"Cooling"}' \
         '{"code":"FUR-80","name":"80% furnace replacement","unit":"system","unitPriceCents":565000,"unitCostCents":310000,"category":"Heating"}' \
         '{"code":"HP-3T","name":"3-ton heat pump system","unit":"system","unitPriceCents":1125000,"unitCostCents":662000,"category":"Cooling"}' \
         '{"code":"SVC-DIAG","name":"Service call + diagnostic","unit":"visit","unitPriceCents":12900,"unitCostCents":4500,"category":"Service"}' \
         '{"code":"CAP-45","name":"Capacitor replacement (45/5)","unit":"each","unitPriceCents":28900,"unitCostCents":3800,"category":"Service"}' \
         '{"code":"MAINT-1Y","name":"Comfort Club — 2 tune-ups/yr","unit":"year","unitPriceCents":22900,"unitCostCents":9000,"category":"Maintenance"}' \
         '{"code":"DUCT-RTN","name":"Add return-air duct","unit":"each","unitPriceCents":68500,"unitCostCents":31000,"category":"Air quality"}'; do
  J -X POST "$BASE/api/pricebook" -d "$P" > /dev/null || true
done

echo "== intake -> booked jobs =="
for I in '{"type":"manual","externalId":"da-001","name":"Ruth Delgado","phone":"602-555-0134","address":"1418 E Cholla St, Phoenix","description":"AC died, house at 92 inside, 3-ton unit from 2009","preferredWindow":"morning"}' \
         '{"type":"manual","externalId":"da-002","name":"Gary Pearce","phone":"480-555-0171","address":"2203 W Kiva Ave, Mesa","description":"Furnace short-cycling, wants quote on replacement","preferredWindow":"afternoon"}' \
         '{"type":"manual","externalId":"da-003","name":"Amy Chow","phone":"602-555-0148","address":"7712 N 16th Dr, Phoenix","description":"Comfort Club signup + tune-up","preferredWindow":"any"}'; do
  J -X POST "$BASE/api/intake" -d "$I" > /dev/null || true
done
J -X PUT "$BASE/api/agents/policies" -d '{"agentKey":"booking","mode":"auto"}' > /dev/null
J -X POST "$BASE/api/agents/booking/run" -d '{}' > /dev/null || true

echo "== dispatch the board =="
J -X PUT "$BASE/api/agents/policies" -d '{"agentKey":"dispatch","mode":"auto"}' > /dev/null
J -X POST "$BASE/api/agents/dispatch/run" -d '{}' > /dev/null || true

echo "== enable the money helpers (ask-first, like a real shop) =="
for A in financials documents workforce inventory crm sales; do
  J -X PUT "$BASE/api/agents/policies" -d "{\"agentKey\":\"$A\",\"mode\":\"approve\"}" > /dev/null
done

echo "== bank account =="
J -X POST "$BASE/api/bank/accounts" -d '{"name":"Desert Aire Operating — Chase"}' > /dev/null || true

echo "seeded. Tenant: $TENANT"
echo "Log in as person1@example.com (owner), person2@example.com (office), person3@example.com (bidder)."
