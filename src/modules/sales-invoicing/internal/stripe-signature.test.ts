import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyStripeSignature } from "./stripe";

const SECRET = "whsec_test_0123456789abcdef";
const OLD_SECRET = "whsec_test_previous_secret_value";

function sign(payload: string, secret: string, t: number): string {
  return createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
}

describe("verifyStripeSignature", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  let now: number;

  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    now = Math.floor(Date.now() / 1000);
  });
  afterEach(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("accepts a correctly signed payload", () => {
    const h = `t=${now},v1=${sign(payload, SECRET, now)}`;
    expect(verifyStripeSignature(payload, h)).toBe(true);
  });

  /**
   * The rotation bug. Stripe signs with BOTH secrets during a rollover and
   * sends several v1 values. Object.fromEntries kept only the LAST one, so
   * when our secret produced an earlier signature every event was rejected —
   * payments silently stopped posting during the maintenance window.
   */
  it("accepts when our signature is FIRST among several v1 values", () => {
    const h = `t=${now},v1=${sign(payload, SECRET, now)},v1=${sign(payload, OLD_SECRET, now)}`;
    expect(verifyStripeSignature(payload, h)).toBe(true);
  });

  it("accepts when our signature is LAST among several v1 values", () => {
    const h = `t=${now},v1=${sign(payload, OLD_SECRET, now)},v1=${sign(payload, SECRET, now)}`;
    expect(verifyStripeSignature(payload, h)).toBe(true);
  });

  it("still rejects when NONE of the v1 values is ours", () => {
    const h = `t=${now},v1=${sign(payload, OLD_SECRET, now)},v1=${sign(payload, "whsec_nope", now)}`;
    expect(verifyStripeSignature(payload, h)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const h = `t=${now},v1=${sign(payload, SECRET, now)}`;
    expect(verifyStripeSignature(`${payload} `, h)).toBe(false);
  });

  it("rejects a replay outside the 5-minute window", () => {
    const old = now - 400;
    expect(verifyStripeSignature(payload, `t=${old},v1=${sign(payload, SECRET, old)}`)).toBe(
      false,
    );
  });

  it("rejects a missing or malformed header", () => {
    expect(verifyStripeSignature(payload, null)).toBe(false);
    expect(verifyStripeSignature(payload, "garbage")).toBe(false);
    expect(verifyStripeSignature(payload, `t=${now}`)).toBe(false);
  });

  it("fails CLOSED when no webhook secret is configured", () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const h = `t=${now},v1=${sign(payload, SECRET, now)}`;
    expect(verifyStripeSignature(payload, h)).toBe(false);
  });
});
