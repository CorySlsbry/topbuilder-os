/**
 * seed-demo-richness — ADDITIVE enrichment for the Desert Aire demo tenant.
 *
 * The base seed (seed-demo-tenant.ts) is a RESET: it purges and rebuilds.
 * This script is the opposite contract — it only ADDS, checks before every
 * insert, and is safe to re-run against a live demo. It exists so the
 * prospecting/sales surfaces have something honest to show a prospect:
 * an aging equipment fleet, memberships in every state the signals engine
 * reads, declined quotes inside the lookback, and a pipeline with a deal
 * in every stage.
 *
 * Same law as the base seed: GL-touching writes go through the module
 * ports (enroll posts its invoice through the real posting engine), so the
 * trial balance still ties. Direct SQL is used only for what the product
 * does by clock — backdating an estimate to 90 days ago, or setting the
 * agreement status the nightly rollover would have set by now.
 *
 *   DATABASE_URL=postgres://app_user:...@localhost:5433/topbuilder \
 *   npx tsx --conditions=react-server scripts/seed-demo-richness.ts
 */
import { getPool } from "../src/lib/db/pool";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { createCustomer, createEquipment, DEFAULT_POSTING_ACCOUNTS, type EquipmentKind } from "@/modules/field-ops";
import { createEstimate } from "@/modules/estimating";
import { createPlan, enroll, listPlans } from "@/modules/agreements";
import { recordPayment } from "@/modules/sales-invoicing";
import { advanceStage, createOpportunity, geocodePending, type Stage } from "@/modules/prospecting";

function yearsAgoIso(years: number): string {
  const d = new Date();
  d.setDate(d.getDate() - Math.round(years * 365.25));
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const t = await getPool().query<{ id: string | null }>(
    "SELECT app.tenant_id_by_slug($1) AS id",
    ["desert-aire"],
  );
  const tenantId = t.rows[0]?.id;
  if (!tenantId) throw new Error("no tenant 'desert-aire'");
  const scope: TenantScope = { uid: "seed:richness", tenantId };

  // ------------------------------------------------------------- customers
  // Three more households/businesses so the pipeline and the geocoder have
  // fresh material. Addresses are real Phoenix-metro street grid, occupants
  // invented — same rule as the base seed.
  const NEW_CUSTOMERS = [
    { name: "Lopez Family",        phone: "623-555-0177", address: "6236 W Sweetwater Ave, Glendale AZ 85304", email: "lopez.fam@example.com" },
    { name: "Verde Vista Dental",  phone: "602-555-0163", address: "4045 E Bell Rd, Phoenix AZ 85032",         email: "office@verdevista.example.com" },
    { name: "Copper Canyon Coffee", phone: "480-555-0142", address: "1616 S Alma School Rd, Mesa AZ 85210",    email: "hello@coppercanyon.example.com" },
  ];
  const customerId = new Map<string, string>();
  await withTenant(scope, async (c) => {
    const { rows } = await c.query<{ id: string; name: string }>("SELECT id, name FROM customers");
    for (const r of rows) customerId.set(r.name, r.id);
  });
  let addedCustomers = 0;
  for (const cu of NEW_CUSTOMERS) {
    if (customerId.has(cu.name)) continue;
    customerId.set(cu.name, await createCustomer(scope, cu));
    addedCustomers++;
  }
  console.log(`customers: +${addedCustomers} (${customerId.size} total)`);

  const need = (name: string): string => {
    const id = customerId.get(name);
    if (!id) throw new Error(`customer '${name}' not found — base seed missing?`);
    return id;
  };

  // ------------------------------------------------------------- equipment
  // The aging fleet. Ages are chosen against LIFESPAN_YEARS so the signals
  // engine has one of each story: past life, approaching life, and (on the
  // base seed's newer units) silence.
  const FLEET: { customer: string; label: string; kind: EquipmentKind; make: string; years: number }[] = [
    { customer: "Ruth Delgado",        label: "Garage water heater",     kind: "water-heater", make: "Rheem",   years: 12.4 }, // past 11 → 45
    { customer: "Gary Pearce",         label: "3-ton AC, backyard pad",  kind: "ac",           make: "Goodman", years: 13.6 }, // approaching 14 → 25
    { customer: "Bright Star Daycare", label: "Rooftop AC unit #2",      kind: "ac",           make: "Carrier", years: 15.2 }, // past 14 → 45
    { customer: "Sunridge Apartments", label: "RTU — building C",        kind: "rtu",          make: "Trane",   years: 18.4 }, // past 17 → 45
  ];
  let addedEquipment = 0;
  for (const e of FLEET) {
    const cid = need(e.customer);
    const exists = await withTenant(scope, async (c) =>
      (await c.query("SELECT 1 FROM equipment WHERE customer_id = $1 AND label = $2", [cid, e.label])).rowCount,
    );
    if (exists) continue;
    await createEquipment(scope, {
      customerId: cid,
      label: e.label,
      kind: e.kind,
      make: e.make,
      installedOn: yearsAgoIso(e.years),
    });
    addedEquipment++;
  }
  console.log(`equipment: +${addedEquipment} aging units`);

  // ------------------------------------------------------- declined quotes
  // Quotes that walked, inside the 180-day lookback. Created through the
  // real estimate path, then backdated — the decline date is the one fact
  // the product records by clock that a seed has to place in the past.
  const DECLINED = [
    { customer: "Hal & Doreen Brandt", title: "Whole-house duct sealing + new return", cents: 845_000,  daysAgo: 45 },
    { customer: "Bright Star Daycare", title: "RTU #2 replacement proposal",           cents: 1_240_000, daysAgo: 90 },
  ];
  let addedQuotes = 0;
  for (const q of DECLINED) {
    const cid = need(q.customer);
    await withTenant(scope, async (c) => {
      const job = await c.query<{ id: string }>(
        "SELECT id FROM jobs WHERE customer_id = $1 ORDER BY created_at LIMIT 1", [cid],
      );
      const jobId = job.rows[0]?.id;
      if (!jobId) return;
      const dup = await c.query(
        "SELECT 1 FROM estimates WHERE job_id = $1 AND status = 'declined'", [jobId],
      );
      if (dup.rowCount) return;
      const est = await createEstimate(scope, jobId, [{
        tier: "good",
        title: q.title,
        lines: [{ description: q.title, qtyX100: 100, unitPriceCents: q.cents }],
      }]);
      await c.query(
        `UPDATE estimates SET status = 'declined',
                created_at = now() - make_interval(days => $2)
          WHERE id = $1`,
        [est.id, q.daysAgo],
      );
      addedQuotes++;
    });
  }
  console.log(`declined quotes: +${addedQuotes}`);

  // ------------------------------------------------------------ agreements
  // Memberships in the two states the base tenant lacks. Both enroll through
  // the module (the invoice posts through the real ledger); the status is
  // then set to what the nightly rollover would have made it by now.
  const plans = await listPlans(scope);
  let annualPlanId = plans.find((p) => p.billing === "annual")?.id;
  if (!annualPlanId) {
    annualPlanId = await createPlan(scope, {
      name: "Comfort Club", billing: "annual", priceCents: 22_900,
      visitsPerYear: 2, discountBps: 1500, targetMonths: [4, 10],
    });
  }
  let monthlyPlanId = plans.find((p) => p.billing === "monthly")?.id;
  if (!monthlyPlanId) {
    monthlyPlanId = await createPlan(scope, {
      name: "Commercial PM — 3 RTUs", billing: "monthly", priceCents: 24_000,
      visitsPerYear: 4, discountBps: 1000, targetMonths: [1, 4, 7, 10],
    });
  }

  // Hal & Doreen Brandt: paid a year of Comfort Club, membership ran out and
  // they never renewed — then declined a quote too. The classic drifting-away
  // customer, and the exact shape a win-back call is for. (Gary, Ruth and Amy
  // already carry active memberships from the base tenant, so the lapsed
  // story lives here.)
  const brandt = need("Hal & Doreen Brandt");
  const brandtHas = await withTenant(scope, async (c) =>
    (await c.query("SELECT 1 FROM agreements WHERE customer_id = $1", [brandt])).rowCount,
  );
  if (!brandtHas) {
    const { agreementId, invoiceId } = await enroll(scope, {
      planId: annualPlanId, customerId: brandt, startOn: yearsAgoIso(1.11),
    });
    await recordPayment(scope, {
      invoiceId, amountCents: 22_900, method: "check",
      reference: "seed-richness:brandt-comfort-club",
      receivedOn: yearsAgoIso(1.1), accounts: DEFAULT_POSTING_ACCOUNTS,
    });
    await withTenant(scope, (c) =>
      c.query(
        `UPDATE agreements
            SET status = 'expired',
                started_on = $2, period_start = $2, period_end = $3
          WHERE id = $1`,
        [agreementId, yearsAgoIso(1.11), yearsAgoIso(0.11)],
      ),
    );
    console.log("agreement: Hal & Doreen Brandt — expired ~40 days ago (paid, lapsed)");
  }

  // Sunridge Apartments: commercial PM, invoice unpaid past the period —
  // exactly what 'past_due' means, so the invoice stays open on purpose.
  const sunridge = need("Sunridge Apartments");
  const sunridgeHas = await withTenant(scope, async (c) =>
    (await c.query("SELECT 1 FROM agreements WHERE customer_id = $1", [sunridge])).rowCount,
  );
  if (!sunridgeHas) {
    const { agreementId } = await enroll(scope, {
      planId: monthlyPlanId, customerId: sunridge, startOn: yearsAgoIso(0.2),
    });
    await withTenant(scope, (c) =>
      c.query("UPDATE agreements SET status = 'past_due' WHERE id = $1", [agreementId]),
    );
    console.log("agreement: Sunridge Apartments — past_due (invoice open)");
  }

  // ----------------------------------------------------------- opportunities
  // One deal in every stage, so the pipeline rail reads like a working shop
  // rather than an empty grid. Advanced stepwise through the real transition
  // rules — the stage history is genuine, only compressed in time.
  const PIPELINE: { customer: string; title: string; cents: number; path: Stage[]; lostReason?: string }[] = [
    { customer: "Lopez Family",         title: "Duct sealing — Lopez Family",            cents: 149_000,   path: [] },
    { customer: "Sunridge Apartments",  title: "RTU replacement — Sunridge bldg C",      cents: 1_840_000, path: ["qualify"] },
    { customer: "Hal & Doreen Brandt",  title: "Heat pump upgrade — Brandt",             cents: 985_000,   path: ["qualify", "propose"] },
    { customer: "Amy Chow",             title: "Comfort Club renewal — Amy Chow",        cents: 22_900,    path: ["qualify", "propose", "follow_up"] },
    { customer: "Verde Vista Dental",   title: "Smart thermostat bundle — Verde Vista",  cents: 134_700,   path: ["qualify", "propose", "won"] },
    { customer: "Copper Canyon Coffee", title: "UV purifier — Copper Canyon",            cents: 89_500,    path: ["qualify", "lost"], lostReason: "Chose a cheaper bid" },
  ];
  let addedOpps = 0;
  for (const o of PIPELINE) {
    const dup = await withTenant(scope, async (c) =>
      (await c.query("SELECT 1 FROM opportunities WHERE title = $1", [o.title])).rowCount,
    );
    if (dup) continue;
    const { id } = await createOpportunity(scope, {
      customerId: need(o.customer), title: o.title, valueCents: o.cents,
    });
    for (const stage of o.path) {
      await advanceStage(scope, id, stage, stage === "lost" ? o.lostReason : undefined);
    }
    addedOpps++;
  }
  console.log(`opportunities: +${addedOpps} across the pipeline`);

  // -------------------------------------------------------------- geocoding
  // Coordinate the new addresses now instead of waiting for tonight's cron.
  const geo = await geocodePending(scope);
  console.log(`geocode: ok=${geo.ok} failed=${geo.failed} deferred=${geo.deferred}`);

  console.log("\nrichness seeded — additive, idempotent, books still tie.");
  process.exit(0);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
