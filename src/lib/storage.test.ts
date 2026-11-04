import { describe, expect, it } from "vitest";
import { buildStorageKey, isAllowedUpload, objectUrl, storageBackend } from "./storage";

describe("storage keys", () => {
  it("always begins with the tenant prefix", () => {
    const key = buildStorageKey("t-1", "j-1", "image/jpeg");
    expect(key.startsWith("tenants/t-1/jobs/j-1/")).toBe(true);
    expect(key.endsWith(".jpg")).toBe(true);
  });

  it("is unique per call, so an upload never overwrites another", () => {
    const a = buildStorageKey("t-1", "j-1", "image/png");
    const b = buildStorageKey("t-1", "j-1", "image/png");
    expect(a).not.toBe(b);
  });

  it("never derives the extension from caller-supplied text", () => {
    // Unknown types fall back to .bin rather than trusting the input.
    expect(buildStorageKey("t", "j", "application/x-evil").endsWith(".bin")).toBe(true);
  });

  it("allows only the upload types the download route can safely serve", () => {
    for (const t of ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"]) {
      expect(isAllowedUpload(t), t).toBe(true);
    }
    for (const t of ["text/html", "image/svg+xml", "application/javascript", ""]) {
      expect(isAllowedUpload(t), t).toBe(false);
    }
  });

  it("serves objects through an authorized route, never a bucket URL", () => {
    expect(objectUrl("abc")).toBe("/api/attachments/abc");
  });

  it("uses local disk when GCS_BUCKET is unset (dev default)", () => {
    expect(storageBackend()).toBe(process.env.GCS_BUCKET ? "gcs" : "local");
  });
});
