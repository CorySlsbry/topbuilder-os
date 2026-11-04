/**
 * price-gate-proof — prove the billing catalog gate BOTH ways against real
 * Stripe. A gate that only ever answers "yes" is decoration, so this asserts
 * the "no" path explicitly with a lookup_key that cannot exist.
 *
 * Run:  STRIPE_SECRET_KEY=sk_test_... npx tsx --conditions=react-server \
 *       scripts/price-gate-proof.ts
 */
import { PLAN_LIST, priceExists } from "../src/modules/billing";

async function main(): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("set STRIPE_SECRET_KEY");
  const mode = process.env.STRIPE_SECRET_KEY.startsWith("sk_live") ? "LIVE" : "TEST";
  console.log(`Stripe mode: ${mode}\n`);

  let sellable = 0;
  for (const p of PLAN_LIST) {
    const ok = await priceExists(p.lookupKey);
    if (ok) sellable++;
    console.log(`  ${ok ? "SELLABLE" : "hidden  "}  ${p.name.padEnd(6)} $${p.priceCents / 100} — ${p.lookupKey}`);
  }

  // ⛔ The failing case. Without this the run above proves only that Stripe
  // answers, not that a missing price is actually caught.
  const bogus = await priceExists("os_this_price_cannot_exist_9999");
  console.log(`\n  control: a lookup_key with no price -> ${bogus ? "SELLABLE (BROKEN)" : "hidden (correct)"}`);
  if (bogus) throw new Error("FAILED: the gate reports a nonexistent price as sellable");

  console.log(`\n${sellable} of ${PLAN_LIST.length} tiers are sellable in ${mode} mode.`);
  process.exit(0);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
