/**
 * Seed the demo tenant: DESERT AIRE MECHANICAL — a fictional 10-person
 * residential HVAC shop in the Phoenix metro.
 *
 * ⚠️ EVERY name, address, phone number, job and dollar figure here is INVENTED.
 * No real client data appears in this file, and none ever should — the demo is
 * a composite, and it says so on the tenant record.
 *
 * Why a script that calls the module PORTS rather than a pile of INSERTs:
 * every dollar in this tenant is posted by the same deterministic posting
 * engine production uses, so the trial balance ties, the WIP schedule is real,
 * and the job margins are arithmetic rather than decoration. A SQL fixture
 * would look identical on screen and be a lie under the hood — and this
 * product's whole claim is that the numbers are honest.
 *
 * RE-RUNNABLE, by RESET: if the demo tenant already exists its data is purged
 * (via the product's own SECURITY DEFINER purge, which cannot be aimed at
 * another tenant) and rebuilt to a known state. It does NOT top up — an
 * earlier version tried to, and a second run silently produced duplicate
 * customers and jobs before failing on a vendor that already existed.
 *
 * ⚠️ It therefore DELETES the demo tenant's data on every run. It is scoped to
 * the "desert-aire" slug and touches nothing else, but do not point it at a
 * tenant holding real customer data.
 *
 *   DATABASE_URL=...            (the app_user DSN — RLS applies, as in prod)
 *   MIGRATE_DATABASE_URL=...    (owner DSN — used ONLY for directory rows)
 *   DEMO_OWNER_UID=<uid>        (the Identity Platform uid that will own it)
 *   pnpm tsx scripts/seed-demo-tenant.ts
 */
import { Client } from "pg";
import { withTenant, withUid, type TenantScope } from "@/lib/db/tenant";
import { seedNahbChart } from "@/modules/ledger";
import {
  DEFAULT_POSTING_ACCOUNTS,
  captureCost,
  createCustomer,
  createJob,
  scheduleAppointment,
  setJobStatus,
} from "@/modules/field-ops";
import { issueInvoice, recordPayment } from "@/modules/sales-invoicing";
import {
  createWorker,
  listPendingWeeks,
  logTime,
  postWorkerWeek,
  upsertWcClass,
} from "@/modules/workforce";
import { createBill, createVendor } from "@/modules/purchasing-ap";
import { createItem, receiveStock } from "@/modules/inventory";
import { createBankAccount, importStatement } from "@/modules/bank-rec";
import { setEtc, takeWipSnapshot } from "@/modules/job-costing";
import { createIntake } from "@/modules/intake";
import { addPricebookItem } from "@/modules/estimating";
import { runFinancialAgent } from "@/modules/financial-agent";
import { runCrmAgent } from "@/modules/crm";
import { runInventoryAgent } from "@/modules/inventory";
import { createPortalToken } from "@/modules/crm";

const SLUG = "desert-aire";
const NAME = "Desert Aire Mechanical";
const OWNER_UID = process.env.DEMO_OWNER_UID ?? "dev:marcus@desertaire.demo";

/** Dates are relative to today so the demo always looks live, never stale. */
const TODAY = new Date();
function daysAgo(n: number): string {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function daysAhead(n: number): string {
  return daysAgo(-n);
}
function at(dayOffset: number, hour: number): string {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

const A = DEFAULT_POSTING_ACCOUNTS;

/**
 * The crew — ten people across three departments, which is the point: this
 * tenant is what exercises the department walls. Dana and the CPA can see the
 * money; the installers and techs cannot, and the sidebar proves it when you
 * sign in as them.
 */
const TEAM = [
  { uid: "person1@example.com",    name: "Dana Whitfield",   role: "admin",      depts: ["field", "financials"] },
  { uid: "person2@example.com",     name: "Sal Ortiz",        role: "staff",      depts: ["field"] },
  { uid: "person3@example.com",    name: "Tony Alvarez",     role: "staff",      depts: ["field"] },
  { uid: "person4@example.com",  name: "Javier Mendez",    role: "staff",      depts: ["field"] },
  { uid: "person5@example.com",    name: "Alex Boone",       role: "staff",      depts: ["field"] },
  { uid: "person6@example.com",   name: "Andre Willis",     role: "staff",      depts: ["field"] },
  { uid: "person7@example.com",    name: "Rosa Delgado",     role: "staff",      depts: ["field"] },
  { uid: "person8@example.com",  name: "Curtis Nakamura",  role: "staff",      depts: ["field"] },
  { uid: "person9@example.com", name: "Marisol Vega",     role: "viewer",     depts: [] },
  // The CPA seat: free, read + financials. Exactly what an advisor invite mints.
  { uid: "person10@example.com",   name: "Priya Raman, CPA", role: "bookkeeper", depts: ["financials"] },
];

async function main(): Promise<void> {
  const admin = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
  await admin.connect();

  // ---------------------------------------------------------------- tenant
  let tenantId: string;
  const existing = await admin.query<{ id: string }>(
    "SELECT id FROM tenants WHERE slug = $1",
    [SLUG],
  );
  if (existing.rows[0]) {
    tenantId = existing.rows[0].id;
    console.log(`tenant exists: ${tenantId}`);

    // RESET IT, rather than topping it up.
    //
    // The first version of this script claimed to be idempotent and was not:
    // a second run created six more customers and six more jobs, then died on
    // `vendor_exists`. "Top up" is the wrong model for a demo — every entity
    // here would need its own natural key and conflict rule, and the failure
    // mode when one is missed is silent duplicate data that looks plausible.
    //
    // Purge-then-build gives one known state instead. It uses the PRODUCT's
    // own purge — SECURITY DEFINER, takes no tenant argument, reads the GUC —
    // so it is structurally incapable of touching another tenant's data no
    // matter what is passed in. It takes memberships and the tenant row with
    // it, so everything below is rebuilt from scratch.
    await admin.query("SELECT set_config('app.current_uid', $1, false)", [OWNER_UID]);
    await admin.query("SELECT set_config('app.current_tenant', $1, false)", [tenantId]);
    await admin.query(
      "SELECT set_config('app.current_departments', 'field,financials,hr', false)",
    );
    // Note this removes the TENANT ROW too — purge is the full self-service
    // "delete my business", not a data-only truncate. So the tenant is
    // provisioned fresh below, and its id changes on every reset.
    await admin.query("SELECT app.purge_current_tenant()");
    console.log("  previous demo data purged — rebuilding to a known state");
  }

  tenantId = await withUid(OWNER_UID, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "SELECT app.provision_tenant($1, $2, $3) AS id",
      [NAME, SLUG, OWNER_UID],
    );
    return rows[0]!.id;
  });
  console.log(`tenant provisioned: ${tenantId}`);

  const scope: TenantScope = {
    uid: OWNER_UID,
    tenantId,
    // The owner holds every wall (resolveScope expands owner/admin the same
    // way at request time) — the seed must carry them or the department
    // policies added in 0029 would fail closed on its own writes.
    departments: ["field", "financials", "hr"],
  };

  // Scope the ADMIN connection too.
  //
  // On Cloud SQL the `postgres` role is NOT a true superuser, so FORCE RLS
  // binds even the table owner — the same fact that shapes the whole security
  // model here. Locally postgres IS a superuser and these writes sail through,
  // which is exactly how a seed can pass on a laptop and fail in production
  // with "new row violates row-level security policy". Set the scope and the
  // two behave identically.
  await admin.query("SELECT set_config('app.current_uid', $1, false)", [OWNER_UID]);
  await admin.query("SELECT set_config('app.current_tenant', $1, false)", [tenantId]);
  await admin.query(
    "SELECT set_config('app.current_departments', 'field,financials,hr', false)",
  );

  // Departments must exist before any grant can reference them.
  await admin.query(
    `INSERT INTO departments (tenant_id, key, name) VALUES
       ($1,'field','Field & jobs'), ($1,'financials','Money & books'), ($1,'hr','People & pay')
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [tenantId],
  );

  await seedNahbChart(scope);
  console.log("chart of accounts seeded");

  // ------------------------------------------------------------- the team
  // Memberships and grants are directory rows, written with the owner DSN —
  // the same path provision_tenant uses. Everything AFTER this goes through
  // the app role under RLS, exactly as a request would.
  for (const m of TEAM) {
    // NOT `ON CONFLICT DO UPDATE`.
    //
    // The seat-cap trigger is BEFORE INSERT, so it evaluates on every INSERT
    // statement — including one that ON CONFLICT would go on to turn into an
    // update. On a re-run with the plan already full, the 10th member blew up
    // with `seat_limit_reached: 10 of 10` even though it was adding nobody.
    // That made this script single-use while its own header claimed it was
    // idempotent.
    //
    // Guarding with NOT EXISTS means an existing member produces zero rows to
    // insert, the trigger never fires, and the role is corrected separately.
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role)
       SELECT $1, $2, $3
        WHERE NOT EXISTS (
          SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2
        )`,
      [tenantId, m.uid, m.role],
    );
    await admin.query(
      `UPDATE memberships SET role = $3 WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, m.uid, m.role],
    );
    for (const d of m.depts) {
      await admin.query(
        `INSERT INTO member_department_access (tenant_id, membership_id, department_id)
         SELECT $1, ms.id, d.id
           FROM memberships ms, departments d
          WHERE ms.tenant_id = $1 AND ms.user_id = $2
            AND d.tenant_id = $1 AND d.key = $3
         ON CONFLICT (membership_id, department_id) DO NOTHING`,
        [tenantId, m.uid, d],
      );
    }
  }
  console.log(`team: ${TEAM.length + 1} people (owner + ${TEAM.length})`);

  // A live trial, so /billing shows something real.
  await withTenant(scope, async (c) => {
    await c.query(
      `INSERT INTO subscriptions (tenant_id, plan, seat_cap, status, trial_ends_at)
       VALUES ($1,'crew',10,'trialing', now() + interval '18 days')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
  });

  // --------------------------------------------------------- payroll setup
  await upsertWcClass(scope, {
    classCode: "5537",
    description: "HVAC installation & service",
    ratePer100Cents: 850,
  });

  const CREW = [
    { name: "Tony Alvarez",    trade: "lead installer", baseHourlyCents: 3400 },
    { name: "Javier Mendez",   trade: "installer",      baseHourlyCents: 2600 },
    { name: "Alex Boone",      trade: "installer",      baseHourlyCents: 2400 },
    { name: "Andre Willis",    trade: "installer",      baseHourlyCents: 2200 },
    { name: "Rosa Delgado",    trade: "service tech",   baseHourlyCents: 3000 },
    { name: "Curtis Nakamura", trade: "service tech",   baseHourlyCents: 2800 },
    { name: "Sal Ortiz",       trade: "estimator",      baseHourlyCents: 3600 },
  ];
  const workerIds: Record<string, string> = {};
  for (const w of CREW) {
    const id = await createWorker(scope, {
      ...w,
      wcClassCode: "5537",
      ficaBps: 765,
      unemploymentBps: 60,
      benefitsHourlyCents: 180,
    }).catch(() => null);
    if (id) workerIds[w.name] = id;
  }
  console.log(`workers: ${Object.keys(workerIds).length}`);

  // -------------------------------------------------------------- pricebook
  // The flat-rate menu a tech presents on the phone. This is what makes the
  // good-better-best estimate screen demonstrable at all — without it that
  // page is an empty grid, which is exactly how the demo first shipped.
  //
  // Priced as a real Phoenix HVAC shop would: equipment near 45-55% gross
  // margin, service calls higher, maintenance agreements thin but sticky.
  const PRICEBOOK = [
    { code: "AC-3T",     name: "3-ton AC change-out (14.3 SEER2)", category: "Cooling",     unit: "system", unitPriceCents: 785000,  unitCostCents: 432000, description: "Condenser + evaporator coil, haul-away, startup and airflow test" },
    { code: "AC-4T",     name: "4-ton AC change-out (15.2 SEER2)", category: "Cooling",     unit: "system", unitPriceCents: 965000,  unitCostCents: 548000 },
    { code: "AC-5T-RTU", name: "5-ton package RTU (commercial)",   category: "Cooling",     unit: "unit",   unitPriceCents: 1420000, unitCostCents: 845000, description: "Rooftop unit, curb adapter, crane set, controls tie-in" },
    { code: "HP-3T",     name: "3-ton heat pump system",           category: "Cooling",     unit: "system", unitPriceCents: 1125000, unitCostCents: 662000 },
    { code: "FUR-80",    name: "80% furnace replacement",          category: "Heating",     unit: "system", unitPriceCents: 565000,  unitCostCents: 310000 },
    { code: "FUR-96",    name: "96% high-efficiency furnace",      category: "Heating",     unit: "system", unitPriceCents: 742000,  unitCostCents: 421000 },
    { code: "SVC-DIAG",  name: "Service call + diagnostic",        category: "Service",     unit: "visit",  unitPriceCents: 12900,   unitCostCents: 4500 },
    { code: "CAP-45",    name: "Capacitor replacement (45/5 MFD)", category: "Service",     unit: "each",   unitPriceCents: 28900,   unitCostCents: 3800 },
    { code: "CONT-30",   name: "Contactor replacement (2-pole 30A)", category: "Service",   unit: "each",   unitPriceCents: 24900,   unitCostCents: 2250 },
    { code: "TXV-R410",  name: "TXV replacement (R-410A)",         category: "Service",     unit: "each",   unitPriceCents: 68500,   unitCostCents: 19500 },
    { code: "DUCT-RTN",  name: "Add return-air duct",              category: "Air quality", unit: "each",   unitPriceCents: 68500,   unitCostCents: 31000 },
    { code: "DUCT-SEAL", name: "Duct sealing (whole house)",       category: "Air quality", unit: "house",  unitPriceCents: 149000,  unitCostCents: 58000 },
    { code: "UV-LAMP",   name: "UV air purifier, in-duct",         category: "Air quality", unit: "each",   unitPriceCents: 89500,   unitCostCents: 34000 },
    { code: "TSTAT-SM",  name: "Smart thermostat + setup",         category: "Controls",    unit: "each",   unitPriceCents: 44900,   unitCostCents: 18500 },
    { code: "MAINT-1Y",  name: "Comfort Club — 2 tune-ups a year", category: "Maintenance", unit: "year",   unitPriceCents: 22900,   unitCostCents: 9000, description: "Spring AC and fall heat inspection, priority scheduling, 15% off repairs" },
    { code: "MAINT-COMM", name: "Commercial quarterly PM (per RTU)", category: "Maintenance", unit: "year", unitPriceCents: 96000,  unitCostCents: 41000 },
  ];
  for (const item of PRICEBOOK) {
    await addPricebookItem(scope, item).catch(() => {});
  }
  console.log(`pricebook: ${PRICEBOOK.length} flat-rate items across 6 categories`);

  // -------------------------------------------------------------- customers
  const CUSTOMERS = [
    { name: "Ruth Delgado",        phone: "602-555-0134", address: "1418 E Cholla St, Phoenix AZ 85020",   email: "ruth.delgado@example.com" },
    { name: "Gary Pearce",         phone: "480-555-0171", address: "2203 W Kiva Ave, Mesa AZ 85202",       email: "gpearce@example.com" },
    { name: "Amy Chow",            phone: "602-555-0148", address: "7712 N 16th Dr, Phoenix AZ 85021",     email: "amy.chow@example.com" },
    { name: "Bright Star Daycare", phone: "623-555-0192", address: "9040 W Peoria Ave, Peoria AZ 85345",   email: "office@brightstar.example.com" },
    { name: "Hal & Doreen Brandt", phone: "480-555-0119", address: "515 E Vaughn Ave, Gilbert AZ 85234",   email: "hbrandt@example.com" },
    { name: "Sunridge Apartments", phone: "602-555-0156", address: "3300 N 39th Ave, Phoenix AZ 85019",    email: "maint@sunridge.example.com" },
  ];
  const customerIds: Record<string, string> = {};
  for (const c of CUSTOMERS) {
    customerIds[c.name] = await createCustomer(scope, c);
  }
  console.log(`customers: ${CUSTOMERS.length}`);

  // ------------------------------------------------------------------ jobs
  // A deliberate spread of stages, so every screen has something honest on it:
  // one finished and paid, one finished and awaiting payment, two mid-install
  // (these are what make WIP non-trivial), one just scheduled, one lead.
  const jobs: Record<string, string> = {};
  // createJob returns { id, jobNo } — the job number is the human-facing one
  // the crew says out loud; we only need the id to hang everything else off.
  const newJob = async (input: Parameters<typeof createJob>[1]): Promise<string> =>
    (await createJob(scope, input)).id;

  jobs.ruth = await newJob({
    customerId: customerIds["Ruth Delgado"]!,
    name: "3-ton AC change-out — Cholla St",
    jobType: "retail",
    contractCents: 785000,
    budgetCents: 432000,
  });
  jobs.gary = await newJob({
    customerId: customerIds["Gary Pearce"]!,
    name: "80% furnace replacement — Kiva Ave",
    jobType: "retail",
    contractCents: 565000,
    budgetCents: 310000,
  });
  jobs.daycare = await newJob({
    customerId: customerIds["Bright Star Daycare"]!,
    name: "2x 5-ton RTU replacement — Peoria",
    jobType: "retail",
    contractCents: 2840000,
    budgetCents: 1690000,
  });
  jobs.brandt = await newJob({
    customerId: customerIds["Hal & Doreen Brandt"]!,
    name: "Heat pump system + return duct — Gilbert",
    jobType: "retail",
    contractCents: 1193500,
    budgetCents: 693000,
  });
  jobs.sunridge = await newJob({
    customerId: customerIds["Sunridge Apartments"]!,
    name: "Unit 14B condenser replacement",
    jobType: "retail",
    contractCents: 685000,
    budgetCents: 398000,
  });
  jobs.amy = await newJob({
    customerId: customerIds["Amy Chow"]!,
    name: "Comfort Club — annual maintenance",
    jobType: "retail",
    contractCents: 22900,
    budgetCents: 9000,
  });
  console.log(`jobs: ${Object.keys(jobs).length}`);

  // ------------------------------------------------------- vendors + bills
  const supplyId = await createVendor(scope, {
    name: "Desert Valley HVAC Supply",
    phone: "602-555-0300",
    defaultAccountCode: "5010",
  });
  const craneId = await createVendor(scope, {
    name: "Sun City Crane Service",
    phone: "623-555-0288",
    is1099: true,
    taxIdLast4: "4417",
  });
  const sheetMetalId = await createVendor(scope, {
    name: "Ironwood Sheet Metal",
    phone: "480-555-0244",
    is1099: true,
    taxIdLast4: "9082",
  });

  await createBill(scope, {
    vendorId: supplyId,
    issuedOn: daysAgo(11),
    dueOn: daysAhead(19),
    billRef: "DV-88214",
    memo: "Carrier 3-ton condenser + coil — Delgado",
    lines: [{ amountCents: 289400, description: "3-ton condenser + evap coil", jobId: jobs.ruth, costCode: "5010", costKind: "material" }],
  });
  await createBill(scope, {
    vendorId: supplyId,
    issuedOn: daysAgo(6),
    dueOn: daysAhead(24),
    billRef: "DV-88907",
    memo: "2x 5-ton RTU — Bright Star",
    lines: [
      { amountCents: 1042000, description: "2x 5-ton package RTU", jobId: jobs.daycare, costCode: "5010", costKind: "material" },
      { amountCents: 86500, description: "Curb adapters + hardware", jobId: jobs.daycare, costCode: "5010", costKind: "material" },
    ],
  });
  await createBill(scope, {
    vendorId: craneId,
    issuedOn: daysAgo(4),
    dueOn: daysAhead(26),
    billRef: "SCC-2291",
    memo: "Rooftop set — Bright Star Daycare",
    lines: [{ amountCents: 185000, description: "Crane + operator, half day", jobId: jobs.daycare, costCode: "5030", costKind: "sub" }],
  });
  await createBill(scope, {
    vendorId: supplyId,
    issuedOn: daysAgo(41),
    dueOn: daysAgo(11),
    billRef: "DV-87330",
    memo: "80% furnace + flue kit — Pearce",
    lines: [{ amountCents: 214800, description: "80k BTU furnace + flue kit", jobId: jobs.gary, costCode: "5010", costKind: "material" }],
  });
  // The equipment on the two remaining jobs. Without these the demo showed a
  // 96% margin on a finished condenser swap — the labour was posted but the
  // condenser itself had never been costed, which is precisely the "my P&L
  // says fine and my gut says otherwise" gap this product is sold against.
  await createBill(scope, {
    vendorId: supplyId,
    issuedOn: daysAgo(13),
    dueOn: daysAhead(17),
    billRef: "DV-88455",
    memo: "Condenser + line set — Sunridge 14B",
    lines: [{ amountCents: 289000, description: "3.5-ton condenser + line set", jobId: jobs.sunridge, costCode: "5010", costKind: "material" }],
  });
  await createBill(scope, {
    vendorId: supplyId,
    issuedOn: daysAgo(8),
    dueOn: daysAhead(22),
    billRef: "DV-88781",
    memo: "3-ton heat pump system — Brandt",
    lines: [{ amountCents: 485000, description: "3-ton heat pump + air handler", jobId: jobs.brandt, costCode: "5010", costKind: "material" }],
  });
  await createBill(scope, {
    vendorId: sheetMetalId,
    issuedOn: daysAgo(9),
    dueOn: daysAhead(21),
    billRef: "IW-4471",
    memo: "Return-air duct fabrication — Brandt",
    lines: [{ amountCents: 143000, description: "Fabricated return plenum + boot", jobId: jobs.brandt, costCode: "5030", costKind: "sub" }],
  });
  console.log("vendors + bills posted");

  // ------------------------------------------------------------- inventory
  const stock = [
    { name: "45/5 MFD dual run capacitor", unit: "each", reorderPointX100: 800,  reorderQtyX100: 2400, qty: 1800, cost: 380 },
    { name: '3/4" copper line set (50 ft)', unit: "roll", reorderPointX100: 300,  reorderQtyX100: 1000, qty: 200,  cost: 14800 },
    { name: "Contactor, 2-pole 30A",        unit: "each", reorderPointX100: 600,  reorderQtyX100: 1800, qty: 1500, cost: 2250 },
    { name: 'MERV 11 filter 20x25x1',       unit: "each", reorderPointX100: 2400, reorderQtyX100: 7200, qty: 900,  cost: 890 },
  ];
  for (const s of stock) {
    const itemId = await createItem(scope, {
      name: s.name,
      unit: s.unit,
      reorderPointX100: s.reorderPointX100,
      reorderQtyX100: s.reorderQtyX100,
      preferredVendor: "Desert Valley HVAC Supply",
    }).catch(() => null);
    if (itemId) {
      await receiveStock(scope, {
        itemId,
        qtyX100: s.qty,
        unitCostCents: s.cost,
        vendorName: "Desert Valley HVAC Supply",
        occurredOn: daysAgo(20),
      }).catch(() => {});
    }
  }
  // Two items deliberately sit BELOW their reorder point, so the Restocker
  // agent has a real reason to propose something and /inventory isn't a wall
  // of green ticks that proves nothing.
  console.log(`inventory: ${stock.length} items (2 below reorder point)`);

  // ------------------------------------------------------- labor + costs
  // Burdened labor is the number this product exists to get right: wage +
  // FICA + WC by class + benefits, overtime past 40 in a week. Posted through
  // the real path so job margin is arithmetic, not a stored guess.
  const timesheet: [string, string, number, number][] = [
    ["Tony Alvarez",    jobs.ruth,     14, 800],
    ["Javier Mendez",   jobs.ruth,     14, 800],
    ["Tony Alvarez",    jobs.daycare,   6, 1000],
    ["Javier Mendez",   jobs.daycare,   6, 1000],
    ["Alex Boone",      jobs.daycare,   6, 950],
    ["Andre Willis",    jobs.daycare,   5, 900],
    ["Tony Alvarez",    jobs.daycare,   5, 900],
    ["Alex Boone",      jobs.brandt,    9, 850],
    ["Andre Willis",    jobs.brandt,    9, 850],
    ["Rosa Delgado",    jobs.sunridge,  3, 700],
    ["Curtis Nakamura", jobs.amy,       2, 300],
    ["Rosa Delgado",    jobs.gary,     12, 750],
  ];
  let hoursLogged = 0;
  for (const [worker, jobId, ago, hoursX100] of timesheet) {
    const wid = workerIds[worker];
    if (!wid || !jobId) continue;
    await logTime(scope, {
      workerId: wid,
      jobId,
      workDate: daysAgo(ago),
      hoursX100,
      costCode: "5020",
    }).catch(() => {});
    hoursLogged += hoursX100 / 100;
  }
  console.log(`time: ${hoursLogged} hours logged`);

  // POST the weeks. This is the step that turns logged hours into burdened
  // job cost — wage + FICA + workers' comp by class + benefits, overtime past
  // 40 in a week — and it is the whole reason "what did this job make me" is
  // an honest number here and a guess in QuickBooks.
  //
  // Skipping it was the first draft's mistake: every job showed a 90%+ margin
  // because labour, the largest cost on an HVAC change-out, had been logged
  // but never posted. The screens looked great and the numbers were fiction.
  const pending = await listPendingWeeks(scope);
  let postedCents = 0;
  for (const w of pending) {
    const r = await postWorkerWeek(scope, w.workerId, w.weekStart).catch(() => null);
    if (r) postedCents += r.totalCents;
  }
  console.log(
    `labor posted: ${pending.length} worker-weeks, ` +
      `$${(postedCents / 100).toFixed(2)} burdened onto the jobs`,
  );

  // Field-captured costs (the phone-in-the-truck path).
  const costs: [string, string, number, number, string][] = [
    [jobs.ruth,     "5010", 4200,  13, "Line set + fittings from the truck"],
    [jobs.ruth,     "5040", 8900,  13, "Permit — City of Phoenix"],
    [jobs.daycare,  "5040", 24500,  7, "Permit + rooftop inspection"],
    [jobs.brandt,   "5010", 6800,  10, "Thermostat + wire"],
    [jobs.sunridge, "5010", 3150,   3, "Capacitor + contactor"],
  ];
  for (const [jobId, code, amount, ago, memo] of costs) {
    if (!jobId) continue;
    await captureCost(scope, {
      jobId,
      costCode: code,
      kind: code === "5040" ? "other" : "material",
      amountCents: amount,
      occurredOn: daysAgo(ago),
      memo,
      paidFrom: "cash",
      accounts: A,
    }).catch(() => {});
  }
  console.log(`field costs: ${costs.length} captured`);

  // -------------------------------------------------------- job lifecycle
  await setJobStatus(scope, jobs.ruth!, "complete").catch(() => {});
  await setJobStatus(scope, jobs.gary!, "complete").catch(() => {});
  await setJobStatus(scope, jobs.daycare!, "in-progress").catch(() => {});
  await setJobStatus(scope, jobs.brandt!, "in-progress").catch(() => {});
  await setJobStatus(scope, jobs.sunridge!, "complete").catch(() => {});

  // Estimate-to-complete on the two open jobs — the owner-supplied input that
  // makes the WIP schedule mean something.
  await setEtc(scope, jobs.daycare!, 402000).catch(() => {});
  await setEtc(scope, jobs.brandt!, 118000).catch(() => {});

  // ------------------------------------------------------------ dispatch
  const appts: [string, number, number, string][] = [
    [jobs.daycare!,  0, 7,  "Tony Alvarez"],
    [jobs.brandt!,   0, 9,  "Alex Boone"],
    [jobs.amy!,      1, 8,  "Curtis Nakamura"],
    [jobs.sunridge!, 1, 13, "Rosa Delgado"],
    [jobs.daycare!,  2, 7,  "Javier Mendez"],
  ];
  for (const [jobId, dayOffset, hour, who] of appts) {
    await scheduleAppointment(scope, {
      jobId,
      startsAt: at(dayOffset, hour),
      endsAt: at(dayOffset, hour + 4),
      notes: `Assigned: ${who}`,
    }).catch(() => {});
  }
  console.log(`dispatch: ${appts.length} appointments on the board`);

  // ------------------------------------------------- invoices + payments
  // Paid in full — the happy path, and what makes the bank rec tie later.
  const invRuth = await issueInvoice(scope, {
    jobId: jobs.ruth!,
    subtotalCents: 785000,
    issuedOn: daysAgo(9),
    memo: "3-ton AC change-out, complete",
    accounts: A,
  });
  await recordPayment(scope, {
    invoiceId: invRuth.id,
    amountCents: 785000,
    method: "check",
    reference: "CHK-4471",
    receivedOn: daysAgo(3),
    accounts: A,
  });

  // Issued and unpaid, deliberately aged past 30 days so AR aging has a real
  // bucket and the Front Desk agent has a genuine dunning candidate.
  await issueInvoice(scope, {
    jobId: jobs.gary!,
    subtotalCents: 565000,
    issuedOn: daysAgo(38),
    memo: "Furnace replacement, complete",
    accounts: A,
  });

  // Partly paid — deposit taken, balance outstanding.
  const invSun = await issueInvoice(scope, {
    jobId: jobs.sunridge!,
    subtotalCents: 685000,
    issuedOn: daysAgo(12),
    memo: "Unit 14B condenser replacement",
    accounts: A,
  });
  await recordPayment(scope, {
    invoiceId: invSun.id,
    amountCents: 300000,
    method: "ach",
    reference: "ACH-20881",
    receivedOn: daysAgo(8),
    accounts: A,
  });

  // Progress billing on the open commercial job — this is what puts a real
  // over/under number on the WIP schedule instead of a zero.
  await issueInvoice(scope, {
    jobId: jobs.daycare!,
    subtotalCents: 1420000,
    issuedOn: daysAgo(5),
    memo: "Progress billing 1 of 2 — RTU replacement",
    accounts: A,
  });
  console.log("invoices: 4 issued, 1 paid in full, 1 partial, 1 aged 38 days");

  // --------------------------------------------------------------- bank
  const bankId = await createBankAccount(scope, {
    name: "Desert Aire Operating — Chase",
    glAccountCode: A.cash,
  }).catch(async () => {
    const rows = await withTenant(scope, async (c) =>
      (await c.query<{ id: string }>("SELECT id FROM bank_accounts LIMIT 1")).rows,
    );
    return rows[0]!.id;
  });

  // A statement with a deliberate mix: two that match postings we already
  // made (they should reconcile), several that do NOT (they land in the
  // For-Review queue, which is where the Bookkeeper agent earns its keep),
  // and one obviously personal charge, because that is the real-life case the
  // owner-draw reclass path exists for.
  const statement = [
    "Date,Description,Amount",
    `${daysAgo(3)},CHECK DEPOSIT 4471,7850.00`,
    `${daysAgo(8)},ACH CREDIT SUNRIDGE APTS,3000.00`,
    `${daysAgo(11)},DESERT VALLEY HVAC SUPPLY,-2894.00`,
    `${daysAgo(6)},SHELL OIL 574192 PHOENIX,-92.40`,
    `${daysAgo(5)},CITY OF PHOENIX PERMITS,-245.00`,
    `${daysAgo(4)},SUN CITY CRANE SVC,-1850.00`,
    `${daysAgo(2)},COSTCO WHSE #1163,-284.15`,
    `${daysAgo(2)},SRP UTILITY PAYMENT,-418.77`,
    `${daysAgo(1)},AMERICAN EXPRESS PAYMENT,-1240.00`,
    `${daysAgo(1)},ADP PAYROLL FEES,-186.00`,
    `${daysAgo(1)},ADP WAGE PAY,-14820.00`,
  ].join("\n");

  const imported = await importStatement(scope, {
    bankAccountId: bankId,
    filename: "chase-operating.csv",
    content: statement,
  }).catch((e: unknown) => {
    console.log(`  (statement import skipped: ${String(e)})`);
    return null;
  });
  if (imported) {
    console.log(`bank: ${imported.rowsNew} imported, ${imported.autoMatched} auto-matched, ${imported.rowsNew - imported.autoMatched} waiting in For Review`);
  }

  // ---------------------------------------------------------------- WIP
  await takeWipSnapshot(scope, jobs.daycare!, daysAgo(0)).catch(() => {});
  await takeWipSnapshot(scope, jobs.brandt!, daysAgo(0)).catch(() => {});

  // -------------------------------------------------------------- intake
  const intakes = [
    { source: "manual" as const, externalId: "da-i-101", name: "Wendell Pope",  phone: "602-555-0177", address: "4409 N 27th Pl, Phoenix", description: "AC blowing warm, house is 88 inside", preferredWindow: "morning" as const },
    { source: "manual" as const, externalId: "da-i-102", name: "Nia Foster",    phone: "480-555-0163", address: "1120 S Roosevelt, Tempe",  description: "Wants a quote on a heat pump swap", preferredWindow: "afternoon" as const },
    { source: "manual" as const, externalId: "da-i-103", name: "Ken Yamashita", phone: "623-555-0139", address: "8801 W Union Hills, Peoria", description: "Comfort Club signup + fall tune-up", preferredWindow: "any" as const },
  ];
  for (const i of intakes) {
    await createIntake(scope, i).catch(() => {});
  }
  console.log(`intake: ${intakes.length} requests waiting`);

  // ------------------------------------------------------ customer portal
  await createPortalToken(scope, customerIds["Bright Star Daycare"]!).catch(() => {});

  // ------------------------------------------------------- agent policies
  // Ask-first everywhere, which is how a real shop would run it and what the
  // product promises: the helpers PROPOSE, a human decides.
  await withTenant(scope, async (c) => {
    for (const key of ["financials", "documents", "workforce", "inventory", "crm", "dispatch", "booking", "sales"]) {
      await c.query(
        `INSERT INTO agent_policies (tenant_id, agent_key, mode, updated_by)
         VALUES ($1,$2,'approve',$3)
         ON CONFLICT (tenant_id, agent_key) DO UPDATE SET mode = 'approve'`,
        [tenantId, key, OWNER_UID],
      );
    }
  });
  console.log("helpers: 7 enabled in ask-first mode");

  // Run three of them so the Helpers screen opens with real proposals rather
  // than an empty state. Every card here is deterministic: the Bookkeeper
  // matches bank lines against learned rules and the chart of accounts, the
  // Front Desk finds the genuinely-overdue invoice, the Restocker finds the
  // two items actually below their reorder point. Nothing is invented.
  //
  // These need the AUTHORIZATION facts, not just the tenant — propose() now
  // checks each kind's own `requires`, so a scope without role and aal cannot
  // reach it. That is the point of the type.
  const actor = {
    ...scope,
    departments: scope.departments ?? [],
    role: "owner" as const,
    aal: "aal2" as const,
  };
  const ran: string[] = [];
  const fin = await runFinancialAgent(actor).catch(() => null);
  if (fin) ran.push(`bookkeeper proposed ${fin.proposed}`);
  const crm = await runCrmAgent(actor).catch(() => null);
  if (crm) ran.push(`front desk proposed ${crm.reviewsProposed + crm.dunningProposed}`);
  const inv = await runInventoryAgent(actor).catch(() => null);
  if (inv) ran.push(`restocker proposed ${inv.proposed}`);
  console.log(`helper runs: ${ran.join(", ") || "(none)"}`);

  await admin.end();

  console.log("\n=== Desert Aire Mechanical is seeded ===");
  console.log(`tenant   ${tenantId}`);
  console.log(`owner    ${OWNER_UID}`);
  console.log(`people   ${TEAM.length + 1} (1 owner, 1 admin, 7 staff, 1 viewer, 1 bookkeeper)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
