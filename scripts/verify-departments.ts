/**
 * Proves the dynamic-department behaviour against a real database.
 *
 * The HTTP route is aal2-gated (correctly — shaping who sees what is
 * privilege escalation), and dev login is aal1 on purpose, so the endpoint
 * sweep can only assert the gate REFUSES. This exercises the logic underneath
 * it by calling the module functions directly with a scope, which is where the
 * rules actually live.
 *
 *   npx tsx scripts/verify-departments.ts
 */
import { Client } from "pg";
import { getPool } from "@/lib/db/pool";
import {
  createDepartment,
  deleteDepartment,
  listTeam,
  renameDepartment,
  setMemberDepartments,
} from "@/modules/auth-tenancy";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function expectError(name: string, code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(name, false, `expected ${code}, but it SUCCEEDED`);
  } catch (err) {
    const actual = (err as { code?: string }).code ?? String(err);
    check(name, actual === code, `got ${actual}`);
  }
}

const pool = getPool();

// The tenant lookup runs on the OWNER connection: `tenants` is RLS-enabled and
// app_user only sees rows it holds a membership for, so an unscoped read as
// app_user correctly returns nothing. (Same trap that produced a false alarm
// against production earlier — an unscoped query is not evidence of absence.)
const admin = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await admin.connect();
const t = await admin.query<{ id: string; name: string }>(
  "SELECT id, name FROM tenants WHERE name LIKE 'Desert Aire%' LIMIT 1",
);
const tenant = t.rows[0];
if (!tenant) {
  console.error("No Desert Aire tenant locally — seed first.");
  process.exit(1);
}
const scope = { uid: "verify-departments", tenantId: tenant.id };
console.log(`\ntenant: ${tenant.name}\n`);

// A member to grant things to — anyone who is not owner/admin, since
// owner/admin implicitly hold every wall and would prove nothing.
const m = (
  await admin.query<{ user_id: string }>(
    "SELECT user_id FROM memberships WHERE tenant_id = $1 AND role NOT IN ('owner','admin') LIMIT 1",
    [tenant.id],
  )
).rows[0];
if (!m) {
  console.error("No non-admin member to test grants against.");
  process.exit(1);
}
const userId = m.user_id;

console.log("1. Create custom departments");
await createDepartment(scope, "install-crews", "Install crews");
await createDepartment(scope, "service", "Service");
const after = await listTeam(scope);
const keys = after.departments.map((d) => d.key);
check("both created", keys.includes("install-crews") && keys.includes("service"), keys.join(", "));
await expectError("duplicate key refused", "department_exists", () =>
  createDepartment(scope, "service", "Service Again"),
);
await expectError("bad key refused", "department_key_invalid", () =>
  createDepartment(scope, "Bad Key!", "Nope"),
);

console.log("\n2. Assign an ARBITRARY MIX to one person");
// The point of the whole feature: a standard wall AND two custom ones,
// related or not, on the same person.
await setMemberDepartments(scope, userId, ["financials", "install-crews", "service"]);
const team = await listTeam(scope);
const mine = team.members.find((x) => x.userId === userId);
check(
  "three departments held at once",
  mine?.departments.length === 3 &&
    ["financials", "install-crews", "service"].every((k) => mine.departments.includes(k)),
  mine?.departments.join(", "),
);

console.log("\n3. Unknown keys are REFUSED, not silently dropped");
await expectError("unknown key rejected", "unknown_department", () =>
  setMemberDepartments(scope, userId, ["financials", "typo-dept"]),
);
const unchanged = (await listTeam(scope)).members.find((x) => x.userId === userId);
check(
  "the failed call changed nothing",
  unchanged?.departments.length === 3,
  unchanged?.departments.join(", "),
);

console.log("\n4. Protected + in-use deletes are refused");
for (const k of ["field", "financials", "hr"]) {
  await expectError(`${k} cannot be deleted`, "department_protected", () =>
    deleteDepartment(scope, k),
  );
}
await expectError("in-use custom dept cannot be deleted", "department_in_use", () =>
  deleteDepartment(scope, "install-crews"),
);

console.log("\n5. Rename works and keeps grants");
await renameDepartment(scope, "install-crews", "Install & retrofit");
const renamed = await listTeam(scope);
check(
  "renamed",
  renamed.departments.find((d) => d.key === "install-crews")?.name === "Install & retrofit",
);
check(
  "grants survived the rename",
  renamed.members.find((x) => x.userId === userId)?.departments.includes("install-crews") === true,
);

console.log("\n6. Cleanup — unassign, then delete");
await setMemberDepartments(scope, userId, []);
await deleteDepartment(scope, "install-crews");
await deleteDepartment(scope, "service");
const final = await listTeam(scope);
check(
  "back to the three standard departments",
  final.departments.length === 3,
  final.departments.map((d) => d.key).join(", "),
);

await admin.end();
await pool.end();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
