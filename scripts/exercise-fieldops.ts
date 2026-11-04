/**
 * Live end-to-end exercise of the field-ops slice (dev only):
 * provision → tax profile (customer's state) → customer → insurance job →
 * schedule → capture cost (cost_entry + GL post in one tx) → job screen →
 * complete → depreciation nudge → purge.
 *
 *   NODE_OPTIONS=--conditions=react-server \
 *   DATABASE_URL=... MIGRATE_DATABASE_URL=... pnpm tsx scripts/exercise-fieldops.ts
 */
import { Client } from "pg";
import { withUid } from "@/lib/db/tenant";
import { getTrialBalance, seedNahbChart } from "@/modules/ledger";
import {
  captureCost,
  createCustomer,
  createJob,
  getJobScreen,
  scheduleAppointment,
  setJobStatus,
  upsertTaxProfile,
} from "@/modules/field-ops";
import type { PostingAccounts } from "@/modules/job-costing";

const ACCOUNTS: PostingAccounts = {
  cash: "1020",
  ar: "1210",
  retainageReceivable: "1290",
  revenue: "3100",
  taxPayable: "2210",
  customerDeposits: "2100",
  dealerFeeCost: "5600",
  jobCost: "1430", // NAHB direct construction cost (wip-control)
  ap: "2020",
};

async function main(): Promise<void> {
  const stamp = Date.now().toString(36);
  const uid = "dev:fieldops@example.com";
  const tenantId = await withUid(uid, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "SELECT app.provision_tenant($1, $2, $3) AS id",
      [`FieldOps Exercise ${stamp}`, `fieldops-ex-${stamp}`, uid],
    );
    return rows[0]!.id;
  });
  const scope = { uid, tenantId, departments: ["field-ops", "financials"] };
  console.log("tenant:", tenantId);

  await seedNahbChart(scope);
  // Onboarding: the CUSTOMER'S state drives the tax profile (a plain retail
  // state here — nothing hardcoded anywhere).
  await upsertTaxProfile(scope, { state: "ut", method: "retail", stateBps: 485, countyBps: 135 });
  console.log("tax profile set for state UT (retail)");

  const customerId = await createCustomer(scope, { name: "Sam Smith", phone: "555-0101" });
  const job = await createJob(scope, {
    customerId,
    name: "Smith re-roof (hail claim)",
    jobType: "insurance-restoration",
    contractCents: 2_000_000,
    budgetCents: 1_200_000,
    claimNumber: "CLM-4417",
    carrier: "Acme Mutual",
    acvCents: 1_100_000,
    rcvCents: 2_000_000,
  });
  console.log(`job created: #${job.jobNo} (${job.id})`);
  if (job.jobNo !== 1) throw new Error("expected job_no 1");

  await scheduleAppointment(scope, {
    jobId: job.id,
    startsAt: "2026-08-01T13:00:00Z",
    endsAt: "2026-08-01T21:00:00Z",
    assigneeUid: uid,
  });

  const cost = await captureCost(scope, {
    jobId: job.id,
    costCode: "4100",
    kind: "material",
    amountCents: 84_200,
    occurredOn: "2026-08-01",
    memo: "shingles",
    paidFrom: "cash",
    accounts: ACCOUNTS,
  });
  console.log("cost captured:", cost.costEntryId, "→ GL", cost.journalEntryId);

  let screen = await getJobScreen(scope, job.id);
  if (screen.costTotalCents !== 84_200) throw new Error("job screen cost total wrong");
  if (screen.appointmentCount !== 1) throw new Error("appointment count wrong");
  if (screen.depreciationNudge) throw new Error("nudge should NOT fire before completion");
  console.log("job screen: costs", screen.costTotalCents, "| appts", screen.appointmentCount, "| nudge", screen.depreciationNudge);

  const tb = await getTrialBalance(scope);
  const d = tb.reduce((s, r) => s + r.debitCents, 0);
  const c2 = tb.reduce((s, r) => s + r.creditCents, 0);
  if (d !== c2) throw new Error("trial balance broken");
  console.log("GL ties:", d, "=", c2);

  await setJobStatus(scope, job.id, "complete", "2026-08-02");
  screen = await getJobScreen(scope, job.id);
  if (!screen.depreciationNudge) throw new Error("depreciation nudge missing after completion");
  console.log("depreciation nudge FIRES after completion (RCV recorded, not yet invoiced)");

  const admin = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.ledger_purge', 'on', true)");
    await admin.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await admin.query("COMMIT");
  } finally {
    await admin.end();
  }
  console.log("FIELD-OPS EXERCISE: ALL CHECKS PASSED");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
