import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The law this file exists to hold: A TABLE USED TO RESOLVE TENANCY CANNOT BE
 * FORCE-SCOPED BY TENANCY.
 *
 * `SECURITY DEFINER` runs as the table's owner. `FORCE ROW LEVEL SECURITY` is
 * exactly the setting that makes policies bind the owner too. Every resolution
 * function answers a question asked BEFORE a session exists — so
 * `app.current_tenant` is unset, the policy matches nothing, and the function
 * returns NULL. Not an error. Not a log line. Just NULL, which every caller
 * then handles politely as "not found".
 *
 * It has cost this codebase three outages, found weeks apart:
 *   0040 — every inbound customer text was silently discarded.
 *   0041 — the customer portal, the CPA invite channel, and the Stripe billing
 *          webhook's tenant lookup were all dead in production. The portal one
 *          was proven against the live database before it was fixed.
 *
 * Three times is not a fluke, and a comment did not stop it. pgTAP would be the
 * natural home for this, but the pgTAP runner needs Docker and CI does not have
 * it — so the check lives here, reads the migrations, and runs on every commit.
 *
 * ── Adding a SECURITY DEFINER function? ───────────────────────────────────
 * This test will fail until you list it below and state which tables it reads.
 * That is the point: the decision gets made in writing, once, by a person.
 */

const MIGRATIONS = join(process.cwd(), "migrations");

/** Every SECURITY DEFINER function in the schema, and what it touches. */
const DEFINER_FUNCTIONS: Record<
  string,
  {
    /** Tables it reads BEFORE a tenant scope exists. These must never be FORCE. */
    resolves: string[];
    why: string;
  }
> = {
  // ---- resolution: reached with no session at all -------------------------
  tenant_id_by_slug: {
    resolves: ["tenants"],
    why: "public booking form / voice webhook resolve a tenant from its public slug",
  },
  tenant_booking_profile: {
    resolves: ["tenants", "booking_settings"],
    why:
      "the public self-booking page needs the shop's name, TIMEZONE and whether " +
      "booking is even switched on, all before any session exists. A slot offered " +
      "in the wrong clock is a wrong promise to a homeowner; a FORCE-scoped " +
      "booking_settings would make every shop's page claim booking is off",
  },
  lock_slot: {
    resolves: [],
    why: "advisory lock only — touches no table",
  },
  assert_valid_timezone: { resolves: [], why: "trigger; validates the row being written" },
  tie_out_contract: { resolves: [], why: "trigger; runs inside the caller's scoped transaction" },
  tenant_id_by_sms_number: {
    resolves: ["tenant_sms_numbers"],
    why: "Twilio tells us which of our numbers was texted; that is the tenant selector",
  },
  portal_context: {
    resolves: ["portal_tokens", "tenants"],
    why: "the portal token IS the authentication; there is no session to scope by",
  },
  redeem_advisor_invite: {
    resolves: ["advisor_invites"],
    why: "the CPA has a code and no membership yet, which is the whole point",
  },
  tenant_by_stripe_customer: {
    resolves: ["subscriptions"],
    why: "Stripe payload tenant ids are not trusted, so this lookup IS the resolution",
  },

  provision_tenant: {
    resolves: ["tenants", "memberships"],
    why: "signup: it CREATES the tenant, so there is nothing to scope by yet",
  },

  // ---- cross-tenant by design: enumerate, then scope per tenant -----------
  cron_tenants: {
    resolves: ["tenants"],
    why: "the daily heartbeat enumerates tenants, then withTenant()s each one",
  },
  lir_cohorts: {
    resolves: ["tenants"],
    why:
      "platform retention chart. It reads FORCE money tables, so since 0041 it " +
      "loops tenants and sets app.current_tenant per tenant rather than asking " +
      "for FORCE to be dropped on the ledger",
  },

  // ---- not resolution: called with a scope already established ------------
  purge_current_tenant: { resolves: [], why: "acts on the ALREADY-scoped tenant" },
  enforce_seat_cap: { resolves: [], why: "trigger, runs inside the caller's scoped transaction" },
  sync_tenant_sms_number: { resolves: [], why: "trigger on comms_settings, caller is scoped" },
  next_counter: { resolves: [], why: "counter allocation inside a scoped transaction" },
  can_see_department: { resolves: [], why: "reads the request's own GUCs" },
  forbid_ledger_change: { resolves: [], why: "immutability trigger" },
  current_tenant: { resolves: [], why: "reads the GUC" },
  current_uid: { resolves: [], why: "reads the GUC" },
  current_departments: { resolves: [], why: "reads the GUC" },
  normalize_phone: { resolves: [], why: "pure text function" },
};

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function allSql(): string {
  return migrationFiles()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

/**
 * The FINAL force state of a table, replaying migrations in order — because
 * `ALTER TABLE x NO FORCE` in a later migration must beat `FORCE` in an
 * earlier one. Reading the whole corpus for the word FORCE would get this
 * exactly backwards.
 */
function finalForceState(table: string): "force" | "no-force" | "absent" {
  let state: "force" | "no-force" | "absent" = "absent";
  const force = new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`, "i");
  const noForce = new RegExp(
    `ALTER\\s+TABLE\\s+${table}\\s+NO\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
    "i",
  );
  for (const f of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    // NO FORCE first: "ALTER TABLE x FORCE" is a substring of "…NO FORCE…"
    // only in the reader's head, but the regexes must still be applied in an
    // order where the more specific one wins per file.
    if (noForce.test(sql)) state = "no-force";
    else if (force.test(sql)) state = "force";
  }
  return state;
}

const RESOLUTION_TABLES = [
  ...new Set(Object.values(DEFINER_FUNCTIONS).flatMap((d) => d.resolves)),
];

describe("resolution tables are never FORCE-scoped", () => {
  it.each(RESOLUTION_TABLES)("%s is not FORCE", (table) => {
    const state = finalForceState(table);
    expect(
      state,
      `${table} is read by a SECURITY DEFINER function before a session exists.\n` +
        `FORCE makes RLS bind the owner, so that lookup returns NOTHING and the\n` +
        `feature fails silently. Use ENABLE + a policy, never FORCE. See 0041.`,
    ).not.toBe("force");
  });

  // The matching "RLS is still ENABLED and a policy still exists" assertion is
  // deliberately NOT here. Some tables get theirs through dynamic SQL (0020
  // enables RLS for three tables in a FOREACH loop), so grepping the source
  // reports a false failure — which is the exact class of mistake this file
  // exists to prevent. That assertion belongs against reality, and it lives in
  // migration 0041's verification block, which reads pg_class and pg_policies
  // and refuses to finish if either is wrong.
});

describe("every SECURITY DEFINER function is accounted for", () => {
  it("no unlisted definer function exists", () => {
    const sql = allSql();
    const found = new Set<string>();
    // CREATE [OR REPLACE] FUNCTION app.<name>( … ) … SECURITY DEFINER
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+app\.(\w+)\s*\(([\s\S]*?)\$(\w*)\$/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      if (/SECURITY\s+DEFINER/i.test(m[2]!)) found.add(m[1]!);
    }
    const unlisted = [...found].filter((n) => !(n in DEFINER_FUNCTIONS));
    expect(
      unlisted,
      `these SECURITY DEFINER functions are not listed in DEFINER_FUNCTIONS:\n` +
        `  ${unlisted.join("\n  ")}\n` +
        `Add each one with the tables it reads BEFORE a tenant scope exists.\n` +
        `If it reads none, say so — an empty list is a decision on the record.`,
    ).toEqual([]);
  });

  it("the list has no stale entries", () => {
    const sql = allSql();
    const stale = Object.keys(DEFINER_FUNCTIONS).filter(
      (n) => !new RegExp(`FUNCTION\\s+app\\.${n}\\s*\\(`, "i").test(sql),
    );
    expect(stale, `listed functions that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });
});
