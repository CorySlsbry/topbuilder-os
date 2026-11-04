import "server-only";
import { HttpError } from "@/lib/http/errors";
import { accountMismatch } from "./stripe-account";

// Thin Stripe REST client for the SaaS-billing side. Raw fetch (no SDK
// dependency), key-gated, fails closed. Prices are resolved by lookup_key
// so no price id is ever hardcoded and test/live behave identically.

export class BillingError extends HttpError {
  constructor(status: 400 | 402 | 403 | 404 | 409 | 422 | 502 | 503, code: string) {
    super(status, code);
  }
}

export function billingEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function key(): string {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new BillingError(503, "billing_not_configured");
  return k;
}

/** Form-encode nested params the way Stripe expects (a[b][c]=v). */
function encode(data: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) {
      out.push(...encode(v as Record<string, unknown>, name));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object") {
          out.push(...encode(item as Record<string, unknown>, `${name}[${i}]`));
        } else {
          out.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out;
}

/**
 * Prove the configured key belongs to Top Builder AI before anything writes.
 *
 * ⛔ ONE call per process, memoized, and deliberately placed inside
 * `stripeRequest` rather than at the eight call sites that mutate. A guard you
 * have to remember to add is a guard that a ninth call site will not have. The
 * catalog gate below carries the same reasoning in its own comment: enforced
 * instead of remembered.
 *
 * ⛔ A DEFINITE mismatch is fatal and cached — it will never become right, and
 * every additional attempt is another object created in someone else's books.
 * An INCONCLUSIVE answer (network, 5xx, auth) is not cached and does not block:
 * the write that follows carries the same credential and will fail on its own
 * merits, so refusing here would only convert a Stripe outage into an outage of
 * ours. Same fail-open-on-uncertainty line the price gate draws.
 */
let accountVerification: Promise<void> | null = null;

async function verifyAccount(): Promise<void> {
  const acct = await stripeRequest<{ id?: string }>("account");
  const problem = accountMismatch(acct.id);
  if (problem) {
    // Account ids are not secrets; the key is never logged.
    console.error("[stripe] ⛔ WRONG ACCOUNT — refusing to write. %s", problem);
    throw new BillingError(503, "stripe_account_mismatch");
  }
}

export async function assertStripeAccount(): Promise<void> {
  if (!accountVerification) {
    accountVerification = verifyAccount().catch((err) => {
      if (err instanceof BillingError && err.code === "stripe_account_mismatch") throw err;
      accountVerification = null; // inconclusive — let the next write re-check
    });
  }
  return accountVerification;
}

export async function stripeRequest<T>(
  path: string,
  opts: { method?: "GET" | "POST" | "DELETE"; data?: Record<string, unknown>; idempotencyKey?: string } = {},
): Promise<T> {
  const method = opts.method ?? (opts.data ? "POST" : "GET");
  // The whole point of this file's account guard. GETs are safe to answer from
  // whatever account holds the key — a wrong read is retractable. Anything that
  // MUTATES waits for identity first.
  if (method !== "GET") await assertStripeAccount();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key()}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers,
    body: opts.data ? encode(opts.data).join("&") : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string; param?: string; type?: string };
    };
    // Stripe's `message` is the only part that says what actually went wrong.
    // It never reaches the client (the thrown code is deliberately opaque),
    // but swallowing it entirely makes every failure look identical in the
    // logs — which cost real debugging time on 2026-07-24.
    console.error("[stripe] %s %s -> %d %s", method, path, res.status, {
      type: body.error?.type,
      code: body.error?.code,
      param: body.error?.param,
      message: body.error?.message,
    });
    throw new BillingError(502, `stripe:${res.status}:${body.error?.code ?? "unknown"}`);
  }
  return (await res.json()) as T;
}

/** Resolve a price id from its lookup_key. Cached per process — price ids
 *  don't change during a deployment's life. */
const priceCache = new Map<string, string>();

export async function priceIdFor(lookupKey: string): Promise<string> {
  const hit = priceCache.get(lookupKey);
  if (hit) return hit;
  const r = await stripeRequest<{ data: { id: string }[] }>(
    `prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true&limit=1`,
  );
  const id = r.data[0]?.id;
  if (!id) throw new BillingError(503, `price_not_found:${lookupKey}`);
  priceCache.set(lookupKey, id);
  return id;
}

/**
 * Does Stripe actually have a price for this lookup_key?
 *
 * ⛔ THE CATALOG RULE, ENFORCED INSTEAD OF REMEMBERED. The house rule is that
 * "a plan the billing system cannot charge should not exist in the catalog" —
 * and until now that was a sentence in a comment, kept true by whoever
 * remembered to create the Stripe price before adding the tier. Light was
 * about to prove how that fails: the plan lands in code, the price exists in
 * test but not live, and production shows a buy button that throws
 * `price_not_found` at whoever clicks it.
 *
 * ⛔ FAILS OPEN, ON PURPOSE, AND ONLY HERE. A missing price is a definite
 * answer: don't offer it. A Stripe OUTAGE is not — and a pricing page that
 * empties itself because Stripe had a bad minute is a worse failure than
 * showing a plan that briefly cannot be bought. So: 503 `price_not_found`
 * hides the plan; anything else (network, auth, 5xx) keeps it.
 */
export async function priceExists(lookupKey: string): Promise<boolean> {
  try {
    await priceIdFor(lookupKey);
    return true;
  } catch (err) {
    if (err instanceof BillingError && err.code.startsWith("price_not_found")) return false;
    return true; // an outage must not empty the pricing page
  }
}

export function publishableKey(): string | null {
  return process.env.STRIPE_PUBLISHABLE_KEY ?? null;
}
