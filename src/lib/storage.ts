import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Object storage behind one small port.
 *
 * Two backends, chosen by whether GCS_BUCKET is set:
 *   - GCS (production) — per-tenant key prefixes, private bucket, uniform
 *     access, public access prevention enforced.
 *   - local disk (dev)  — a gitignored directory.
 *
 * ⚠️ Why this stopped being "wire it up when GCP is provisioned": GCP HAD been
 * provisioned, and this still wrote to `<cwd>/.uploads`. On Cloud Run that is
 * container-local and ephemeral, so every uploaded receipt and job photo was
 * DESTROYED on each redeploy and invisible to sibling instances in between —
 * a second instance serving a download 500s on a file it cannot see. Those are
 * accounting records; losing them quietly is the worst version of this bug.
 *
 * Raw REST rather than @google-cloud/storage: the SDK is ~50 MB of transitive
 * dependencies for three HTTP calls, and the codebase already talks to Stripe
 * and Identity Platform the same way.
 */

const LOCAL_ROOT = resolve(process.cwd(), ".uploads");
const BUCKET = process.env.GCS_BUCKET;

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  // GIF arrives from MMS more often than from a file picker; a customer's
  // texted photo must not be dropped because the map was written with the
  // upload button in mind.
  "image/gif": "gif",
  "application/pdf": "pdf",
};

export function isAllowedUpload(contentType: string): boolean {
  return contentType in EXT_BY_TYPE;
}

/**
 * A storage key under `tenants/{id}/...`, with a generated filename.
 *
 * Every segment is sanitised even though every current caller passes ids we
 * generated: the containment check in localPath() is the real guarantee, and
 * this keeps a future caller that passes a user-supplied folder name from
 * being the interesting one.
 */
export function buildObjectKey(
  tenantId: string,
  parts: string[],
  contentType: string,
): string {
  const ext = EXT_BY_TYPE[contentType] ?? "bin";
  const safe = [tenantId, ...parts].map((p) => p.replace(/[^\w.-]/g, "_"));
  return `tenants/${safe[0]}/${safe.slice(1).join("/")}/${randomUUID()}.${ext}`;
}

export function buildStorageKey(
  tenantId: string,
  jobId: string,
  contentType: string,
): string {
  return buildObjectKey(tenantId, ["jobs", jobId], contentType);
}

/**
 * The containment check, in ONE place both read and write go through.
 *
 * It used to live only in putObject(), with a comment on this file explaining
 * that traversal was impossible "by construction" because we generate every
 * key. That was true — every writer of job_attachments.storage_key and
 * pricebook_items.photo_key uses buildStorageKey()/randomUUID(). But the
 * guarantee lived in a comment while the READ path did readFile() on whatever
 * string the row held, so the day someone adds a bulk import that carries a
 * supplied filename, the comment stays true and the code becomes arbitrary
 * file read. Enforce it where it is used, not where it happens to be safe.
 */
function localPath(key: string): string {
  const target = resolve(join(LOCAL_ROOT, key));
  if (target !== LOCAL_ROOT && !target.startsWith(LOCAL_ROOT + sep)) {
    throw new Error("storage key escaped the upload root");
  }
  return target;
}

// ------------------------------------------------------------------- GCS
/**
 * An access token for the runtime service account.
 *
 * On Cloud Run this comes from the metadata server — no key file exists, and
 * none should. Cached until shortly before expiry so an upload is not paying
 * for a token round trip every time.
 */
let tokenCache: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) throw new Error(`metadata token failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token: json.access_token,
    // 60s of slack so a token never expires mid-request.
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
  return json.access_token;
}

async function gcsPut(key: string, bytes: Buffer, contentType: string): Promise<void> {
  const url =
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(BUCKET!)}/o` +
    `?uploadType=media&name=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": contentType,
    },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) throw new Error(`gcs upload failed: ${res.status}`);
}

async function gcsGet(key: string): Promise<Buffer> {
  const url =
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(BUCKET!)}/o/` +
    `${encodeURIComponent(key)}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  });
  if (!res.ok) throw new Error(`gcs download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ------------------------------------------------------------------ port
export function storageBackend(): "gcs" | "local" {
  return BUCKET ? "gcs" : "local";
}

export async function putObject(
  key: string,
  bytes: Buffer,
  contentType = "application/octet-stream",
): Promise<void> {
  if (BUCKET) return gcsPut(key, bytes, contentType);
  const target = localPath(key);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

export async function getObject(key: string): Promise<Buffer> {
  if (BUCKET) return gcsGet(key);
  return readFile(localPath(key));
}

/** Served back through an authorized route, never a public URL. */
export function objectUrl(attachmentId: string): string {
  return `/api/attachments/${attachmentId}`;
}
