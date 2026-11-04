import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";

/**
 * Card-on-file, the PCI-honest way.
 *
 * The card number is typed by the CUSTOMER into a Stripe element in their
 * portal — never by the office into ours. We store Stripe REFERENCES (pm id,
 * brand, last4) and charge them off_session for membership autopay. The
 * office can see "Visa ····4242, exp 12/27" and nothing more, which is the
 * entire point: nothing here is worth stealing.
 *
 * Same raw-REST, key-gated, fail-closed pattern as the rest of the Stripe
 * surface. No SDK.
 */

export class CardError extends HttpError {
  constructor(status: 402 | 404 | 409 | 422 | 502 | 503, code: string) {
    super(status, code);
  }
}

function key(): string {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new CardError(503, "payments_not_configured");
  return k;
}

async function stripe<T>(
  path: string,
  body?: Record<string, string>,
  idempotencyKey?: string,
): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${key()}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body ? new URLSearchParams(body) : undefined,
  });
  const json = (await res.json()) as T & { error?: { message?: string; code?: string } };
  if (!res.ok) {
    console.error(`[stripe] ${path} failed:`, json.error?.code, json.error?.message);
    throw new CardError(res.status === 402 ? 402 : 502, json.error?.code ?? "stripe_error");
  }
  return json;
}

/** Ensure the END-customer exists at Stripe; cache the id on our row. */
async function ensureStripeCustomer(
  scope: TenantScope,
  customerId: string,
): Promise<string> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      stripe_customer_id: string | null;
      name: string;
      email: string | null;
    }>(`SELECT stripe_customer_id, name, email FROM customers WHERE id = $1`, [customerId]);
    const cu = rows[0];
    if (!cu) throw new CardError(404, "customer_not_found");
    if (cu.stripe_customer_id) return cu.stripe_customer_id;

    const created = await stripe<{ id: string }>("customers", {
      name: cu.name,
      ...(cu.email ? { email: cu.email } : {}),
      // Tenant binding lives in metadata so a support engineer reading the
      // Stripe dashboard can always answer "whose customer is this?".
      "metadata[tenant_id]": scope.tenantId,
      "metadata[customer_id]": customerId,
    });
    await c.query(`UPDATE customers SET stripe_customer_id = $2 WHERE id = $1`, [
      customerId,
      created.id,
    ]);
    return created.id;
  });
}

/**
 * Start a save-a-card session for the portal: a SetupIntent whose
 * client_secret the portal feeds to Stripe's element. The secret is only
 * useful WITH the customer's card in hand — it authorizes saving, not
 * charging.
 */
export async function createCardSetup(
  scope: TenantScope,
  customerId: string,
): Promise<{ clientSecret: string }> {
  const stripeCustomer = await ensureStripeCustomer(scope, customerId);
  const si = await stripe<{ client_secret: string }>("setup_intents", {
    customer: stripeCustomer,
    "payment_method_types[]": "card",
    usage: "off_session",
    "metadata[tenant_id]": scope.tenantId,
  });
  return { clientSecret: si.client_secret };
}

/**
 * After the portal confirms the SetupIntent client-side, it posts the id
 * back and this verifies WITH STRIPE what actually got saved — the client's
 * claim is never trusted, the same rule as every webhook.
 */
export async function confirmCardSetup(
  scope: TenantScope,
  customerId: string,
  setupIntentId: string,
): Promise<{ id: string; brand: string; last4: string }> {
  if (!/^seti_[A-Za-z0-9]+$/.test(setupIntentId)) {
    throw new CardError(422, "bad_setup_intent");
  }
  const si = await stripe<{
    status: string;
    customer: string | null;
    payment_method:
      | string
      | { id: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } }
      | null;
  }>(`setup_intents/${encodeURIComponent(setupIntentId)}?expand[]=payment_method`);

  if (si.status !== "succeeded" || !si.payment_method) {
    throw new CardError(409, "setup_not_complete");
  }
  const pm = typeof si.payment_method === "string" ? { id: si.payment_method } : si.payment_method;
  const card = "card" in pm ? (pm.card ?? {}) : {};

  return withTenant(scope, async (c) => {
    // The SetupIntent must belong to THIS customer's Stripe record — a
    // portal token for customer A cannot attach A's card to customer B.
    const { rows } = await c.query<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM customers WHERE id = $1`,
      [customerId],
    );
    if (!rows[0]?.stripe_customer_id || rows[0].stripe_customer_id !== si.customer) {
      throw new CardError(409, "setup_customer_mismatch");
    }
    const ins = await c.query<{ id: string }>(
      `INSERT INTO saved_payment_methods
         (tenant_id, customer_id, stripe_pm_id, brand, last4, exp_month, exp_year)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, stripe_pm_id) DO UPDATE SET status = 'active'
       RETURNING id`,
      [
        scope.tenantId,
        customerId,
        pm.id,
        card.brand ?? "",
        card.last4 ?? "",
        card.exp_month ?? null,
        card.exp_year ?? null,
      ],
    );
    return { id: ins.rows[0]!.id, brand: card.brand ?? "", last4: card.last4 ?? "" };
  });
}

/**
 * Charge a saved card off_session — membership autopay. Returns the Stripe
 * payment-intent id for payments.reference, or throws 402 when the card
 * declines (the agreement goes past_due; nobody retries in a loop).
 */
export async function chargeSavedCard(
  scope: TenantScope,
  input: {
    paymentMethodId: string;
    amountCents: number;
    description: string;
    /** Ours — makes the Stripe call retry-safe end to end. */
    idempotencyKey: string;
  },
): Promise<{ paymentIntentId: string }> {
  const pmRow = await withTenant(scope, (c) =>
    c
      .query<{ stripe_pm_id: string; customer_id: string; status: string }>(
        `SELECT stripe_pm_id, customer_id, status FROM saved_payment_methods WHERE id = $1`,
        [input.paymentMethodId],
      )
      .then((r) => r.rows[0] ?? null),
  );
  if (!pmRow || pmRow.status !== "active") throw new CardError(404, "card_not_found");
  const stripeCustomer = await ensureStripeCustomer(scope, pmRow.customer_id);

  const pi = await stripe<{ id: string; status: string }>(
    "payment_intents",
    {
      amount: String(input.amountCents),
      currency: "usd",
      customer: stripeCustomer,
      payment_method: pmRow.stripe_pm_id,
      off_session: "true",
      confirm: "true",
      description: input.description,
      "metadata[tenant_id]": scope.tenantId,
    },
    input.idempotencyKey,
  );
  if (pi.status !== "succeeded") throw new CardError(402, "card_declined");
  return { paymentIntentId: pi.id };
}

export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
}

export async function listSavedCards(
  scope: TenantScope,
  customerId: string,
): Promise<SavedCard[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT id, brand, last4, exp_month AS "expMonth", exp_year AS "expYear"
         FROM saved_payment_methods
        WHERE customer_id = $1 AND status = 'active' ORDER BY created_at DESC`,
      [customerId],
    );
    return rows as SavedCard[];
  });
}
