import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Token encryption at rest — ONE implementation for every third-party
 * credential this system holds: QuickBooks OAuth tokens, and now bank-feed
 * access tokens.
 *
 * Local AES-256-GCM keyed from TOKEN_ENCRYPTION_KEY (any high-entropy string,
 * hashed to 32 bytes). When this moves to a Cloud KMS envelope it swaps
 * behind these two functions and no caller changes.
 *
 * Format: `v1:<iv b64>:<tag b64>:<ciphertext b64>` — self-describing, so a
 * future v2 can be told apart without a schema migration.
 *
 * ⛔ GCM, not CBC. The auth tag means a tampered ciphertext FAILS to decrypt
 * rather than returning plausible garbage — which for a bank access token is
 * the difference between an error and an unexplained API call.
 */

function key(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 16) {
    throw new Error("TOKEN_ENCRYPTION_KEY missing or too short (>=16 chars)");
  }
  return createHash("sha256").update(secret).digest();
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export function decryptToken(blob: string): string {
  const [v, ivB64, tagB64, ctB64] = blob.split(":");
  if (v !== "v1" || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("unrecognized token blob format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
