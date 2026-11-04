import { beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
  process.env.SESSION_SECRET = "test-session-secret";
});

describe("verifyStripeSignature", () => {
  it("accepts a valid t.v1 signature and rejects tamper/stale", async () => {
    const { verifyStripeSignature } = await import("./stripe");
    const payload = '{"id":"evt_1","type":"checkout.session.completed"}';
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", "whsec_test_secret")
      .update(`${t}.${payload}`)
      .digest("hex");
    expect(verifyStripeSignature(payload, `t=${t},v1=${v1}`)).toBe(true);
    expect(verifyStripeSignature(payload + " ", `t=${t},v1=${v1}`)).toBe(false);
    const stale = t - 3600;
    const v1s = createHmac("sha256", "whsec_test_secret")
      .update(`${stale}.${payload}`)
      .digest("hex");
    expect(verifyStripeSignature(payload, `t=${stale},v1=${v1s}`)).toBe(false);
    expect(verifyStripeSignature(payload, null)).toBe(false);
  });

  it("⛔ verifies against EVERY comma-separated secret — two endpoints, one var", async () => {
    // Stripe issues each webhook ENDPOINT its own whsec. This product has two
    // (invoice payments + subscription billing) sharing one env var; an event
    // signed by EITHER endpoint's secret must verify, and garbage still must
    // not. Without this, whichever endpoint's secret is listed second has
    // every event rejected 401 — silently, because Stripe just retries and
    // eventually disables the endpoint.
    const { verifyStripeSignature } = await import("./stripe");
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_payments, whsec_billing";
    try {
      const payload = '{"id":"evt_2","type":"customer.subscription.updated"}';
      const t = Math.floor(Date.now() / 1000);
      const first = createHmac("sha256", "whsec_payments").update(`${t}.${payload}`).digest("hex");
      const second = createHmac("sha256", "whsec_billing").update(`${t}.${payload}`).digest("hex");
      const wrong = createHmac("sha256", "whsec_neither").update(`${t}.${payload}`).digest("hex");
      expect(verifyStripeSignature(payload, `t=${t},v1=${first}`)).toBe(true);
      expect(verifyStripeSignature(payload, `t=${t},v1=${second}`)).toBe(true);
      expect(verifyStripeSignature(payload, `t=${t},v1=${wrong}`)).toBe(false);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
    }
  });
});

describe("paymentMac", () => {
  it("binds tenant+invoice; any mutation changes the MAC", async () => {
    const { paymentMac } = await import("./stripe");
    const a = paymentMac("tenant-1", "inv-1");
    expect(paymentMac("tenant-1", "inv-1")).toBe(a);
    expect(paymentMac("tenant-2", "inv-1")).not.toBe(a);
    expect(paymentMac("tenant-1", "inv-2")).not.toBe(a);
  });
});
