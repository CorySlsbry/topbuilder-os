import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio's request signature — the only thing standing between a public URL
 * and anyone in the world writing messages into a shop's inbox.
 *
 * The scheme (Twilio Security docs): take the exact URL Twilio was configured
 * to call, append every POST parameter as `key + value` in lexicographic key
 * order, HMAC-SHA1 with the account's auth token, base64.
 *
 * ── The part that bites everyone ──────────────────────────────────────────
 * "The exact URL Twilio called" is NOT `request.url` on Cloud Run. The load
 * balancer terminates TLS and forwards `http://` on an internal host, so
 * signing over `request.url` produces a signature that never matches and the
 * webhook 401s in production while passing locally. The URL has to be
 * reconstructed from the PUBLIC origin, which is why this function takes it as
 * an argument instead of reading the request.
 *
 * SHA-1 is not a choice we get to make — it is Twilio's scheme. The comparison
 * is constant-time regardless, so this leaks nothing about the expected value.
 */
/**
 * The exact string Twilio signs. Separated out because it is the half that is
 * easy to get subtly wrong (ordering, concatenation, the URL) and the half a
 * test can check against the published example character for character.
 */
export function signingString(url: string, params: Record<string, string>): string {
  return (
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("")
  );
}

export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  return createHmac("sha1", authToken)
    .update(Buffer.from(signingString(url, params), "utf8"))
    .digest("base64");
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  provided: string,
): boolean {
  const expected = twilioSignature(authToken, url, params);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length is not secret; comparing unequal-length buffers throws.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
