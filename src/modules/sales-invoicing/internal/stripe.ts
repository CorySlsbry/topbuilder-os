import "server-only";
import { env } from "@/env";
import { createHmac, timingSafeEqual } from "node:crypto";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { DEFAULT_POSTING_ACCOUNTS } from "@/modules/field-ops";
import { recordPayment } from "./store";

// Stripe card/ACH — the COMPLETE code path, key-gated. Raw REST (no SDK
// dependency): checkout sessions to collect, signature-verified webhook to
// post the payment into the ledger. Without keys every entry point fails
// closed with a plain 503 the UI translates ("card payments switch on when
// Stripe is connected") — recording checks/ACH manually keeps working.

export class StripeError extends HttpError {
  constructor(status: 400 | 401 | 404 | 409 | 422 | 502 | 503, code: string) {
    super(status, code);
  }
}

export function stripeEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

function secretKey(): string {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new StripeError(503, "payments_not_configured");
  return k;
}

/** Binds tenant + invoice into checkout metadata so a mutated or replayed
 *  webhook can't credit the wrong books (the plan's idempotency MAC). */
export function paymentMac(tenantId: string, invoiceId: string): string {
  const secret = process.env.SESSION_SECRET ?? "dev-only-insecure-session-secret-0000000000";
  return createHmac("sha256", secret).update(`${tenantId}.${invoiceId}`).digest("base64url");
}

export interface CheckoutResult {
  url: string;
  sessionId: string;
}

/** Create a Stripe Checkout session for an invoice's open balance. */
export async function createInvoiceCheckout(
  scope: TenantScope,
  invoiceId: string,
  returnPath: string,
): Promise<CheckoutResult> {
  const inv = await withTenant(scope, async (c) => {
    const { rows } = await c.query<{
      invoice_no: string;
      due_now_cents: string;
      paid_cents: string;
      status: string;
    }>(
      `SELECT invoice_no, due_now_cents, paid_cents, status FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    return rows[0] ?? null;
  });
  if (!inv) throw new StripeError(404, "invoice_not_found");
  const open = Number(inv.due_now_cents) - Number(inv.paid_cents);
  if (inv.status === "void" || open <= 0) throw new StripeError(409, "nothing_due");

  const origin = env().APP_ORIGIN;
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(open),
    "line_items[0][price_data][product_data][name]": `Invoice #${inv.invoice_no}`,
    "payment_method_types[0]": "card",
    "payment_method_types[1]": "us_bank_account",
    success_url: `${origin}${returnPath}?paid=1`,
    cancel_url: `${origin}${returnPath}`,
    "metadata[invoice_id]": invoiceId,
    "metadata[tenant_id]": scope.tenantId,
    "metadata[mac]": paymentMac(scope.tenantId, invoiceId),
  });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new StripeError(502, `stripe_api:${res.status}`);
  const json = (await res.json()) as { id: string; url: string };
  return { url: json.url, sessionId: json.id };
}

/** Verify Stripe's webhook signature (t + v1 HMAC scheme), constant-time.
 *
 * ⛔ STRIPE_WEBHOOK_SECRET MAY HOLD SEVERAL SECRETS, COMMA-SEPARATED. Stripe
 * issues each webhook ENDPOINT its own whsec, and this product has two
 * endpoints (/api/webhooks/stripe for invoice payments, /billing for the
 * subscription lifecycle) that both verify here. One env var per endpoint
 * would work too, but a single list keeps rotation one operation and means
 * a third endpoint someday is config, not code.
 */
export function verifyStripeSignature(payload: string, header: string | null): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const secrets = secret.split(",").map((s) => s.trim()).filter(Boolean);
  if (secrets.length === 0) return false;
  // During a webhook-secret rotation Stripe signs with BOTH secrets and sends
  // several `v1=` values in one header. Object.fromEntries kept only the last
  // one, so if our secret produced any but the last signature every event was
  // rejected — an availability failure during exactly the maintenance window
  // where you least want payments to stop posting. Collect all candidates.
  let t: string | undefined;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") candidates.push(v);
  }
  if (!t || candidates.length === 0) return false;
  // Tolerance: 5 minutes, binding the timestamp per the plan.
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  // No early return: compare every candidate against every secret so the
  // work done does not depend on WHICH signature matched, or which secret.
  let ok = false;
  for (const s of secrets) {
    const expected = createHmac("sha256", s).update(`${t}.${payload}`).digest("hex");
    const b = Buffer.from(expected);
    for (const candidate of candidates) {
      const a = Buffer.from(candidate);
      if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
    }
  }
  return ok;
}

export interface StripeWebhookResult {
  handled: boolean;
  duplicate?: boolean;
}

/**
 * checkout.session.completed → one payment posted into the ledger.
 * Triple-guarded: signature (route), metadata MAC (here), and reference
 * dedupe on the session id (replay = no-op).
 */
export async function handleCheckoutCompleted(event: {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      amount_total: number;
      payment_status: string;
      metadata?: { invoice_id?: string; tenant_id?: string; mac?: string };
    };
  };
}): Promise<StripeWebhookResult> {
  if (event.type !== "checkout.session.completed") return { handled: false };
  const s = event.data.object;
  if (s.payment_status !== "paid") return { handled: false };
  const { invoice_id, tenant_id, mac } = s.metadata ?? {};
  if (!invoice_id || !tenant_id || !mac) throw new StripeError(400, "missing_metadata");
  const expected = paymentMac(tenant_id, invoice_id);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new StripeError(401, "metadata_mac_mismatch");
  }

  const scope: TenantScope = { uid: "stripe:webhook", tenantId: tenant_id } as TenantScope;

  // Dedupe lives INSIDE recordPayment now, under the invoice row lock, with a
  // UNIQUE index on (tenant_id, reference) behind it (migration 0030).
  //
  // What used to be here was a SELECT in its own committed transaction
  // followed by recordPayment in another. Stripe delivers at least once and
  // retries; two overlapping deliveries both passed that SELECT before either
  // INSERT landed, and both posted DR cash / CR AR. The books stayed balanced,
  // so nothing alarmed — it would have surfaced as a bank rec that wouldn't
  // tie, weeks later. Two transactions cannot dedupe each other.
  const result = await recordPayment(scope, {
    invoiceId: invoice_id,
    amountCents: s.amount_total,
    method: "stripe",
    reference: s.id,
    receivedOn: new Date().toISOString().slice(0, 10),
    accounts: DEFAULT_POSTING_ACCOUNTS,
  });
  return { handled: true, duplicate: result.duplicate };
}
