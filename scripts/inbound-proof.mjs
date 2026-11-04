/**
 * Inbound proof — drives the Twilio webhook the way Twilio drives it.
 *
 * The endpoint sweep cannot reach this route: it is authenticated by a
 * signature over the public URL plus every form field, so a generic caller
 * gets a 403 and the whole inbound half of the product would ship covered by
 * nothing but unit tests of the signature function. That is exactly the gap
 * where "it worked locally" lives.
 *
 * What this asserts, against a real database:
 *   1. a FORGED signature is refused (403) and writes nothing
 *   2. a genuine inbound text creates the thread, links the customer by
 *      normalized phone, and lands unread
 *   3. a REDELIVERY of the same MessageSid lands exactly one message and does
 *      NOT double the unread count (carriers retry; shops must not see doubles)
 *   4. a second text from the same number joins the SAME thread
 *   5. "STOP" records the opt-out on the customer, because Twilio enforces it
 *      at the carrier and never tells our database
 *   6. an unknown destination number is a quiet 200 that creates nothing
 *
 *   pnpm dev                          # in one terminal, with TWILIO_AUTH_TOKEN set
 *   node scripts/inbound-proof.mjs    # in another
 */
import { createHmac } from "node:crypto";
import { Client } from "pg";

const BASE = process.env.SWEEP_BASE ?? "http://localhost:5150";
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const WEBHOOK = `${BASE}/api/webhooks/twilio/sms`;
const SHOP_NUMBER = "+16025550100";
const CUSTOMER_NUMBER = "+16025550134";

if (!TOKEN) {
  console.error("TWILIO_AUTH_TOKEN must be set (the same value the server sees)");
  process.exit(1);
}

let pass = 0;
const failures = [];
function check(ok, label, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label} ${detail}`);
  }
}

/** The scheme, restated here on purpose: a proof that imports the code it is
 *  proving would pass even if that code were wrong in the same way. */
function sign(url, params) {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return createHmac("sha1", TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}

async function post(params, { signature } = {}) {
  const body = new URLSearchParams(params);
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature ?? sign(WEBHOOK, params),
    },
    body,
  });
  return res.status;
}

// ─────────────────────────────────────────────────────────────────── setup
const db = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await db.connect();

// Its OWN tenant, always. Borrowing whichever tenant happened to be lying
// around makes the proof's result depend on what ran before it, and the
// endpoint sweep deliberately purges the one it makes.
const SLUG = "inbound-proof";
const { rows: tenants } = await db.query(
  `INSERT INTO tenants (name, slug) VALUES ('Inbound Proof Co', $1)
   ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
   RETURNING id, slug`,
  [SLUG],
);
const tenant = tenants[0];
console.log(`tenant: ${tenant.slug} (${tenant.id})\n`);

async function scoped(sql, params = []) {
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.current_tenant', $1, true)", [tenant.id]);
  const r = await db.query(sql, params);
  await db.query("COMMIT");
  return r;
}

// The shop's number is what routes an inbound message to a tenant.
await scoped(
  `INSERT INTO comms_settings (tenant_id, sms_number, sms_status)
   VALUES ($1, $2, 'active')
   ON CONFLICT (tenant_id) DO UPDATE SET sms_number = $2, sms_status = 'active'`,
  [tenant.id, SHOP_NUMBER],
);
// Clean slate — this script is meant to be re-runnable.
await scoped(
  `DELETE FROM messages WHERE conversation_id IN
     (SELECT id FROM conversations WHERE contact = $1)`,
  [CUSTOMER_NUMBER],
);
await scoped(`DELETE FROM conversations WHERE contact = $1`, [CUSTOMER_NUMBER]);
await scoped(
  `DELETE FROM customers WHERE app.normalize_phone(phone) = $1`,
  [CUSTOMER_NUMBER],
);
// A customer whose phone is stored the way an office types it — the whole
// point of app.normalize_phone().
await scoped(
  `INSERT INTO customers (tenant_id, name, phone)
   VALUES ($1, 'Inbound Proof Customer', '602-555-0134')`,
  [tenant.id],
);

// ───────────────────────────────────────────────────────── 1. forged signature
console.log("1. a forged signature is refused");
const forged = await post(
  {
    MessageSid: "SMforged0000000000000000000000001",
    From: CUSTOMER_NUMBER,
    To: SHOP_NUMBER,
    Body: "let me in",
  },
  { signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
);
check(forged === 403, `forged signature -> ${forged} (want 403)`);
const afterForged = await scoped(
  `SELECT count(*)::int AS n FROM messages WHERE body = 'let me in'`,
);
check(afterForged.rows[0].n === 0, "forged request wrote nothing");

// ───────────────────────────────────────────────────────── 2. genuine inbound
console.log("\n2. a genuine text threads, links the customer, lands unread");
const sid1 = `SMproof${Date.now()}a`;
const s1 = await post({
  MessageSid: sid1,
  From: CUSTOMER_NUMBER,
  To: SHOP_NUMBER,
  Body: "AC is out again, can someone come today?",
  NumMedia: "0",
});
check(s1 === 200, `genuine inbound -> ${s1} (want 200)`);

const t1 = await scoped(
  `SELECT co.id, co.unread, co.customer_id, cu.name AS customer_name,
          (SELECT count(*)::int FROM messages m WHERE m.conversation_id = co.id) AS msgs
     FROM conversations co
     LEFT JOIN customers cu ON cu.id = co.customer_id
    WHERE co.contact = $1`,
  [CUSTOMER_NUMBER],
);
const conv = t1.rows[0];
check(!!conv, "a conversation exists for that number");
check(conv?.msgs === 1, `exactly one message (got ${conv?.msgs})`);
check(conv?.unread === 1, `unread = 1 (got ${conv?.unread})`);
check(
  conv?.customer_name === "Inbound Proof Customer",
  `linked to the customer despite '602-555-0134' vs '+16025550134' (got ${conv?.customer_name})`,
);

// ──────────────────────────────────────────────────────────── 3. redelivery
console.log("\n3. a carrier redelivery lands exactly once");
const s2 = await post({
  MessageSid: sid1,
  From: CUSTOMER_NUMBER,
  To: SHOP_NUMBER,
  Body: "AC is out again, can someone come today?",
  NumMedia: "0",
});
check(s2 === 200, `redelivery -> ${s2} (want 200)`);
const t2 = await scoped(
  `SELECT unread, (SELECT count(*)::int FROM messages m WHERE m.conversation_id = co.id) AS msgs
     FROM conversations co WHERE co.contact = $1`,
  [CUSTOMER_NUMBER],
);
check(t2.rows[0].msgs === 1, `still one message (got ${t2.rows[0].msgs})`);
check(t2.rows[0].unread === 1, `unread NOT doubled (got ${t2.rows[0].unread})`);

// ──────────────────────────────────────────────────────── 4. same thread
console.log("\n4. a second text joins the same thread");
await post({
  MessageSid: `SMproof${Date.now()}b`,
  From: "(602) 555-0134", // typed differently on purpose
  To: SHOP_NUMBER,
  Body: "Actually tomorrow morning is fine",
  NumMedia: "0",
});
const t3 = await scoped(
  `SELECT count(*)::int AS threads FROM conversations WHERE contact = $1`,
  [CUSTOMER_NUMBER],
);
check(t3.rows[0].threads === 1, `still ONE thread (got ${t3.rows[0].threads})`);
const t4 = await scoped(
  `SELECT unread, (SELECT count(*)::int FROM messages m WHERE m.conversation_id = co.id) AS msgs
     FROM conversations co WHERE co.contact = $1`,
  [CUSTOMER_NUMBER],
);
check(t4.rows[0].msgs === 2, `two messages (got ${t4.rows[0].msgs})`);
check(t4.rows[0].unread === 2, `unread = 2 (got ${t4.rows[0].unread})`);

// ──────────────────────────────────────────────────────────── 5. STOP
console.log("\n5. STOP records the opt-out on our side");
await post({
  MessageSid: `SMproof${Date.now()}c`,
  From: CUSTOMER_NUMBER,
  To: SHOP_NUMBER,
  Body: "STOP",
  NumMedia: "0",
});
const opt = await scoped(
  `SELECT sms_opt_out FROM customers WHERE app.normalize_phone(phone) = $1`,
  [CUSTOMER_NUMBER],
);
check(opt.rows[0]?.sms_opt_out === true, "customer.sms_opt_out = true");

console.log("\n5b. START turns it back on");
await post({
  MessageSid: `SMproof${Date.now()}d`,
  From: CUSTOMER_NUMBER,
  To: SHOP_NUMBER,
  Body: "start",
  NumMedia: "0",
});
const optBack = await scoped(
  `SELECT sms_opt_out FROM customers WHERE app.normalize_phone(phone) = $1`,
  [CUSTOMER_NUMBER],
);
check(optBack.rows[0]?.sms_opt_out === false, "customer.sms_opt_out = false");

// ──────────────────────────────────────────────────── 6. unknown number
console.log("\n6. an unknown destination number is a quiet 200 that writes nothing");
const s6 = await post({
  MessageSid: `SMproof${Date.now()}e`,
  From: "+15555550000",
  To: "+19999999999",
  Body: "who is this",
  NumMedia: "0",
});
check(s6 === 200, `unknown To -> ${s6} (want 200, not a retry-forever 5xx)`);
const stray = await scoped(`SELECT count(*)::int AS n FROM conversations WHERE contact = '+15555550000'`);
check(stray.rows[0].n === 0, "no thread created for an unroutable number");

// ──────────────────────────────────────────── 7. the tenant boundary
// The standing rule on this product is that no shop can ever see another
// shop's data. Conversations and messages are the most personal thing in the
// system — a customer's actual words — so the new tables get the same probe
// the money tables get, run as the REAL application role (app_user is
// NOSUPERUSER + NOBYPASSRLS; the migration role would sail through every
// policy and prove nothing).
console.log("\n7. tenant isolation on the new tables, as the app role");

const shapes = await db.query(
  `SELECT relname, relrowsecurity, relforcerowsecurity
     FROM pg_class
    WHERE relname IN ('conversations','messages','message_media','assist_usage',
                      'tenant_sms_numbers')
    ORDER BY relname`,
);
for (const t of shapes.rows) {
  const wantForce = t.relname !== "tenant_sms_numbers";
  check(
    t.relrowsecurity && t.relforcerowsecurity === wantForce,
    `${t.relname}: RLS enabled, force=${wantForce}` +
      (wantForce ? "" : " (directory table — resolves tenancy before a GUC exists)"),
    `got enabled=${t.relrowsecurity} force=${t.relforcerowsecurity}`,
  );
}

const OTHER = "inbound-proof-other";
const { rows: others } = await db.query(
  `INSERT INTO tenants (name, slug) VALUES ('Other Shop', $1)
   ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  [OTHER],
);
const otherId = others[0].id;

const appDsn = process.env.DATABASE_URL;
if (!appDsn) {
  failures.push("DATABASE_URL (the app_user DSN) not set — cannot run the isolation probe");
} else {
  const app = new Client({ connectionString: appDsn });
  await app.connect();
  const su = await app.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  check(
    su.rows[0] && !su.rows[0].rolsuper && !su.rows[0].rolbypassrls,
    "the probe runs as a role that CANNOT bypass RLS",
    JSON.stringify(su.rows[0]),
  );

  async function asTenant(id, sql, params = []) {
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_tenant', $1, true)", [id]);
    const r = await app.query(sql, params);
    await app.query("COMMIT");
    return r;
  }

  const mine = await asTenant(
    tenant.id,
    `SELECT count(*)::int AS n FROM conversations WHERE contact = $1`,
    [CUSTOMER_NUMBER],
  );
  check(mine.rows[0].n === 1, `the owning tenant sees its thread (got ${mine.rows[0].n})`);

  const theirs = await asTenant(
    otherId,
    `SELECT count(*)::int AS n FROM conversations WHERE contact = $1`,
    [CUSTOMER_NUMBER],
  );
  check(theirs.rows[0].n === 0, `another tenant sees ZERO of it (got ${theirs.rows[0].n})`);

  const theirMsgs = await asTenant(otherId, `SELECT count(*)::int AS n FROM messages`);
  check(theirMsgs.rows[0].n === 0, `another tenant reads no messages at all (got ${theirMsgs.rows[0].n})`);

  // Unset scope must be EMPTY, not everything — the fail-closed direction.
  await app.query("BEGIN");
  const unscoped = await app.query(`SELECT count(*)::int AS n FROM conversations`);
  await app.query("COMMIT");
  check(unscoped.rows[0].n === 0, `an UNSCOPED read returns nothing (got ${unscoped.rows[0].n})`);

  // Writing into someone else's tenant must be refused by the policy, not by
  // our own good manners in the application layer.
  let blocked = false;
  try {
    await asTenant(
      otherId,
      `INSERT INTO conversations (tenant_id, contact_kind, contact)
       VALUES ($1,'phone','+16025559999')`,
      [tenant.id],
    );
  } catch {
    blocked = true;
    await app.query("ROLLBACK").catch(() => {});
  }
  check(blocked, "writing a row INTO another tenant is refused by RLS");

  // And the message log really is append-only for the app role.
  let immutable = false;
  try {
    await asTenant(tenant.id, `UPDATE messages SET body = 'rewritten'`);
  } catch {
    immutable = true;
    await app.query("ROLLBACK").catch(() => {});
  }
  check(immutable, "the app role CANNOT edit a message body (column-level grant)");

  await app.end();
}

// ─────────────────────────────────────────────────────────────── verdict
await db.query(`DELETE FROM tenants WHERE slug = $1`, [OTHER]);
await db.end();
console.log(`\n${"─".repeat(64)}`);
console.log(`${pass} checks passed, ${failures.length} problem(s)`);
if (failures.length) {
  console.log("");
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
console.log("INBOUND PATH PROVEN\n");
