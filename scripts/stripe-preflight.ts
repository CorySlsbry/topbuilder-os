/**
 * stripe-preflight — the tool that should have been run before anyone asked
 * Stripe a question about Top Builder, and that must be run before anyone
 * creates a price.
 *
 * It does three things, in this order, and the order is the whole design:
 *
 *   1. Takes the key from GOOGLE SECRET MANAGER ONLY. Not from the environment,
 *      not from the local vault. The vault's `STRIPE_SECRET_KEY` belongs to
 *      "Auto Advisor", a different business, and it answers every request
 *      cheerfully — about someone else. There is no flag to override this.
 *   2. Resolves `GET /v1/account` as its FIRST API call and compares the id to
 *      the one checked into src/modules/billing/internal/stripe-account.ts. A
 *      mismatch exits non-zero before anything else runs.
 *   3. Only then reports the catalog, and only with --create-missing does it
 *      write — never touching a price that already exists.
 *
 * Run:
 *   pnpm tsx scripts/stripe-preflight.ts --mode=live
 *   pnpm tsx scripts/stripe-preflight.ts --mode=live --create-missing
 */
import { execFileSync } from "node:child_process";
import { PLAN_LIST } from "../src/modules/billing/internal/plans";
import { STRIPE_ACCOUNT_ID, accountMismatch } from "../src/modules/billing/internal/stripe-account";

const PROJECT = "builder-ai-497610";
/** ⛔ The ONLY two places a Top Builder Stripe key may come from. */
const SECRET = { live: "tbai-stripe-secret-key-live", test: "tbai-stripe-secret-key-test" } as const;
type Mode = keyof typeof SECRET;

const args = process.argv.slice(2);
const modeArg = args.find((a) => a.startsWith("--mode="))?.slice(7);
const createMissing = args.includes("--create-missing");

function die(msg: string): never {
  console.error(`\n⛔ ${msg}\n`);
  process.exit(1);
}

// No default mode. "It defaulted to live" is how a test write becomes a real
// one, and the cost of typing six characters is lower than the cost of that.
if (modeArg !== "live" && modeArg !== "test") {
  die("pass --mode=live or --mode=test (there is deliberately no default)");
}
const mode: Mode = modeArg;

function secretKey(): string {
  try {
    // On Windows `gcloud` is a .cmd, which node refuses to spawn without a
    // shell — and `shell: true` warns because it concatenates args instead of
    // escaping them. Going through cmd.exe explicitly keeps the args as an
    // array: no warning, no quoting, and it still works unchanged on POSIX.
    const gcloudArgs = [
      "secrets", "versions", "access", "latest",
      `--secret=${SECRET[mode]}`, `--project=${PROJECT}`,
    ];
    const [cmd, cmdArgs] =
      process.platform === "win32"
        ? (["cmd.exe", ["/c", "gcloud", ...gcloudArgs]] as const)
        : (["gcloud", gcloudArgs] as const);
    const k = execFileSync(cmd, [...cmdArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!k) throw new Error("empty");
    return k;
  } catch {
    return die(`could not read Secret Manager secret "${SECRET[mode]}" — run: gcloud auth login`);
  }
}

const KEY = secretKey();
// Mode and key must agree. A live key read from the test secret (or the
// reverse) means the secrets themselves were crossed, and every "which
// environment am I in" assumption below would be wrong.
const keyMode: Mode | null = KEY.startsWith("sk_live") ? "live" : KEY.startsWith("sk_test") ? "test" : null;
if (keyMode !== mode) {
  die(`${SECRET[mode]} holds a ${keyMode ?? "unrecognised"} key but --mode=${mode} was requested`);
}

async function stripe<T>(path: string, form?: Record<string, string>): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: form ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = (await res.json()) as { error?: { message?: string } } & T;
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status} on ${path}`);
  return body;
}

interface Price {
  id: string;
  unit_amount: number | null;
  lookup_key: string | null;
  recurring?: { interval: string } | null;
  product: string;
}

async function main(): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────
  // STEP 1 — identity, first, before anything else is believed.
  // ─────────────────────────────────────────────────────────────────────────
  const acct = await stripe<{ id?: string; settings?: { dashboard?: { display_name?: string } } }>("account");
  const problem = accountMismatch(acct.id);
  if (problem) {
    die(
      `WRONG STRIPE ACCOUNT — ${problem}\n` +
        `   Nothing was read or written. If this key is genuinely correct, the\n` +
        `   expectation in src/modules/billing/internal/stripe-account.ts is what\n` +
        `   needs changing — in a reviewed commit, not at runtime.`,
    );
  }
  const who = acct.settings?.dashboard?.display_name ?? "(unnamed)";
  console.log(`\n✓ account ${acct.id} — ${who}  [${mode.toUpperCase()} mode]`);
  console.log(`  key from Secret Manager: ${SECRET[mode]}\n`);

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 2 — what does the catalog in code expect, and what does Stripe have?
  // ─────────────────────────────────────────────────────────────────────────
  const missing: typeof PLAN_LIST = [];
  let drift = 0;

  for (const p of PLAN_LIST) {
    const r = await stripe<{ data: Price[] }>(
      `prices?lookup_keys[]=${encodeURIComponent(p.lookupKey)}&active=true&limit=1`,
    );
    const price = r.data[0];
    const want = `$${(p.priceCents / 100).toFixed(2)}/mo`;

    if (!price) {
      missing.push(p);
      console.log(`  MISSING   ${p.name.padEnd(6)} ${want.padEnd(12)} ${p.lookupKey}  — not sellable`);
      continue;
    }
    // A price that exists at the WRONG amount is worse than a missing one: the
    // app offers it, the customer is charged something the code never said.
    // Report it loudly; do NOT auto-correct — changing a price that live
    // subscribers are on is a business decision, not a script's call.
    if (price.unit_amount !== p.priceCents) {
      drift++;
      console.log(
        `  ⛔ DRIFT  ${p.name.padEnd(6)} code says ${want}, Stripe charges ` +
          `$${((price.unit_amount ?? 0) / 100).toFixed(2)}/mo  ${p.lookupKey} (${price.id})`,
      );
      continue;
    }
    console.log(`  sellable  ${p.name.padEnd(6)} ${want.padEnd(12)} ${p.lookupKey}  (${price.id})`);
  }

  // The control. Without it this run proves Stripe answers, not that a missing
  // price is actually detected — the same reasoning as price-gate-proof.
  const control = await stripe<{ data: Price[] }>(
    "prices?lookup_keys[]=os_this_price_cannot_exist_9999&active=true&limit=1",
  );
  if (control.data.length) die("control lookup returned a price — this report cannot be trusted");

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 3 — create, only what is missing, only when asked.
  // ─────────────────────────────────────────────────────────────────────────
  if (missing.length && !createMissing) {
    console.log(`\n${missing.length} plan(s) not sellable. Re-run with --create-missing to create them.`);
  }

  if (missing.length && createMissing) {
    console.log(`\nCreating ${missing.length} price(s) in ${mode.toUpperCase()} mode…`);
    for (const p of missing) {
      // Amount, lookup_key and copy all come from PLAN_LIST, so Stripe cannot
      // disagree with the code that resolves it. Nothing is typed twice.
      const product = await stripe<{ id: string }>("products", {
        name: `Top Builder OS — ${p.name}`,
        description: p.blurb,
      });
      const price = await stripe<Price>("prices", {
        product: product.id,
        unit_amount: String(p.priceCents),
        currency: "usd",
        "recurring[interval]": "month",
        lookup_key: p.lookupKey,
        nickname: `${p.name} $${p.priceCents / 100}/mo, ${
          p.seatCap === 1 ? "just you" : `up to ${p.seatCap} people`
        }`,
      });
      console.log(`  created  ${p.name}  ${price.id}  (product ${product.id})  lookup_key=${p.lookupKey}`);
    }

    // Re-read rather than trust the create response: the thing that matters is
    // that the app's own resolution path (lookup_key -> price) now finds it.
    console.log("\nRe-checking by lookup_key, the way the app resolves it:");
    for (const p of missing) {
      const r = await stripe<{ data: Price[] }>(
        `prices?lookup_keys[]=${encodeURIComponent(p.lookupKey)}&active=true&limit=1`,
      );
      const got = r.data[0];
      if (!got || got.unit_amount !== p.priceCents) die(`${p.lookupKey} did not resolve to ${p.priceCents}`);
      console.log(`  ✓ ${p.lookupKey} -> ${got.id}  $${(got.unit_amount ?? 0) / 100}/mo`);
    }
  }

  if (drift) die(`${drift} price(s) disagree with the catalog in code — fix before shipping`);
  console.log(`\nExpected account ${STRIPE_ACCOUNT_ID} confirmed. Done.\n`);
}

main().catch((e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
