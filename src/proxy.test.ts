import { describe, expect, it } from "vitest";
import { crossSiteBlocked } from "./proxy";

/**
 * The same-site (login-CSRF) guard, tested as a contract.
 *
 * ⛔ WHY THIS FILE EXISTS. `proxy.ts` had NO test. The decision lived inside a
 * closure over `NextRequest`, so it could only be exercised by driving real
 * HTTP — and `scripts/endpoint-sweep.mjs` injects `origin: BASE` on every call
 * it makes, so the one shape that mattered was the one nothing sent.
 *
 * The cost of that gap: Cloud Scheduler sends neither `Sec-Fetch-Site` nor
 * `Origin`, so the nightly cron was refused 403 here for a MONTH — 18
 * consecutive PERMISSION_DENIED runs, zero successes — while the sweep stayed
 * green. A guard whose real inputs no test can construct is a guard nobody is
 * checking.
 *
 * So the rule for this file: every case is written as the request a specific
 * real client sends, named after that client.
 */

const post = (over: Partial<Parameters<typeof crossSiteBlocked>[0]> = {}) => ({
  method: "POST",
  pathname: "/api/jobs",
  secFetchSite: null,
  origin: null,
  host: "os.topbuilderai.com",
  ...over,
});

describe("⛔ Cloud Scheduler — the request that was blocked for a month", () => {
  it("lets the nightly cron through", () => {
    // Verified against the live job 2026-08-23: it sends User-Agent and
    // x-cron-secret and NOTHING else. No Origin, no Sec-Fetch-Site.
    expect(crossSiteBlocked(post({ pathname: "/api/cron/daily" }))).toBe(false);
  });

  it("still blocks that same header shape on an ordinary route", () => {
    // The control. Without this, the test above would pass on a guard that had
    // simply been switched off, and would prove nothing at all.
    expect(crossSiteBlocked(post({ pathname: "/api/jobs" }))).toBe(true);
  });

  it("exempts signed webhooks, which have no browser origin either", () => {
    expect(crossSiteBlocked(post({ pathname: "/api/webhooks/stripe" }))).toBe(false);
  });

  it("⛔ the exemption is a PREFIX of the path, not a substring of it", () => {
    // `/api/jobs/api/cron/x` must not buy an exemption by containing the
    // string, and a look-alike sibling must not inherit one.
    expect(crossSiteBlocked(post({ pathname: "/api/jobs/api/cron/daily" }))).toBe(true);
    expect(crossSiteBlocked(post({ pathname: "/api/cronjobs/evil" }))).toBe(true);
  });
});

describe("the attack this guard exists to stop", () => {
  it("blocks a cross-site form POST at the login endpoint", () => {
    // The real attack: an auto-submitted form carrying the ATTACKER's valid id
    // token, which would store THEIR session in the victim's browser.
    expect(
      crossSiteBlocked(post({ pathname: "/api/auth/login", origin: "https://evil.example" })),
    ).toBe(true);
  });

  it("blocks it when the browser announces cross-site directly", () => {
    expect(crossSiteBlocked(post({ secFetchSite: "cross-site" }))).toBe(true);
    expect(crossSiteBlocked(post({ secFetchSite: "same-site" }))).toBe(true);
  });

  it("allows the app's own fetches", () => {
    expect(crossSiteBlocked(post({ secFetchSite: "same-origin" }))).toBe(false);
    // "none" = typed in the address bar or opened from a bookmark.
    expect(crossSiteBlocked(post({ secFetchSite: "none" }))).toBe(false);
  });

  it("⛔ trusts Fetch metadata OVER Origin when both are present", () => {
    // An attacker controls the Origin header far more easily than they control
    // what the browser stamps as Sec-Fetch-Site.
    expect(
      crossSiteBlocked(
        post({ secFetchSite: "cross-site", origin: "https://os.topbuilderai.com" }),
      ),
    ).toBe(true);
  });
});

describe("the Origin fallback, for clients without Fetch metadata", () => {
  it("allows a matching host and blocks a different one", () => {
    expect(crossSiteBlocked(post({ origin: "https://os.topbuilderai.com" }))).toBe(false);
    expect(crossSiteBlocked(post({ origin: "https://evil.example" }))).toBe(true);
  });

  it("⛔ compares HOST, so a look-alike prefix does not pass", () => {
    expect(crossSiteBlocked(post({ origin: "https://os.topbuilderai.com.evil.example" }))).toBe(
      true,
    );
  });

  it("blocks an unparseable Origin rather than reasoning about it", () => {
    expect(crossSiteBlocked(post({ origin: "not a url" }))).toBe(true);
  });

  it("blocks when the host header is missing entirely", () => {
    expect(crossSiteBlocked(post({ origin: "https://os.topbuilderai.com", host: null }))).toBe(
      true,
    );
  });
});

describe("safe methods are never blocked", () => {
  it("lets reads through regardless of where they came from", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(crossSiteBlocked(post({ method, origin: "https://evil.example" }))).toBe(false);
    }
  });

  it("⛔ but every mutating verb IS checked", () => {
    // A guard that covered only POST would be trivially stepped around.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(crossSiteBlocked(post({ method, origin: "https://evil.example" }))).toBe(true);
    }
  });
});
