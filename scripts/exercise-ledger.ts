/**
 * Live end-to-end exercise of the ledger port against the local DB (dev only):
 *   provision tenant → seed NAHB COA → post a balanced entry → trial balance
 *   ties → unbalanced entry rejected → purge the scratch tenant.
 *
 *   DATABASE_URL=postgres://app_user:app_pw@localhost:5432/topbuilder \
 *   MIGRATE_DATABASE_URL=postgres://postgres:postgres@localhost:5432/topbuilder \
 *   pnpm tsx scripts/exercise-ledger.ts
 */
import { Client } from "pg";
import { withUid } from "@/lib/db/tenant";
import {
  getTrialBalance,
  postJournalEntry,
  seedNahbChart,
  LedgerError,
} from "@/modules/ledger";

async function main(): Promise<void> {
  const stamp = Date.now().toString(36);
  const uid = `dev:exercise@example.com`;

  // 1. provision a scratch tenant
  const tenantId = await withUid(uid, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "SELECT app.provision_tenant($1, $2, $3) AS id",
      [`Ledger Exercise ${stamp}`, `ledger-ex-${stamp}`, uid],
    );
    return rows[0]!.id;
  });
  console.log("tenant provisioned:", tenantId);
  const scope = { uid, tenantId, departments: ["financials"] };

  // 2. seed the NAHB chart
  const seeded = await seedNahbChart(scope);
  console.log("NAHB accounts seeded:", seeded);
  if (seeded < 400) throw new Error(`expected ~412 accounts, got ${seeded}`);

  // 3. post a balanced entry: invoice $1,500.00 (DR AR 1210? use real codes)
  const entryId = await postJournalEntry(scope, {
    occurredOn: "2026-05-20",
    memo: "exercise: cash sale",
    sourceType: "manual",
    lines: [
      { accountCode: "1020", debitCents: 150000 }, // Cash, general
      { accountCode: "3100", creditCents: 150000 }, // a revenue account
    ],
  });
  console.log("balanced entry posted:", entryId);

  // 4. trial balance ties
  const tb = await getTrialBalance(scope);
  const d = tb.reduce((s, r) => s + r.debitCents, 0);
  const c2 = tb.reduce((s, r) => s + r.creditCents, 0);
  console.log(`trial balance: ${tb.length} accounts, debits=${d} credits=${c2}`);
  if (d !== c2 || d !== 150000) throw new Error("trial balance does not tie");

  // 5. unbalanced entry rejected by the port (pure validation)
  try {
    await postJournalEntry(scope, {
      occurredOn: "2026-05-21",
      lines: [
        { accountCode: "1020", debitCents: 100 },
        { accountCode: "3100", creditCents: 99 },
      ],
    });
    throw new Error("unbalanced entry was NOT rejected");
  } catch (e) {
    if (e instanceof LedgerError && e.code === "entry_unbalanced") {
      console.log("unbalanced entry rejected:", e.code);
    } else {
      throw e;
    }
  }

  // 6. purge the scratch tenant (privileged path + deliberate purge GUC)
  const admin = new Client({
    connectionString: process.env.MIGRATE_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.ledger_purge', 'on', true)");
    await admin.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await admin.query("COMMIT");
    console.log("scratch tenant purged (cascade through immutable ledger OK)");
  } finally {
    await admin.end();
  }

  console.log("LEDGER EXERCISE: ALL CHECKS PASSED");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
