import { NextResponse, type NextRequest } from "next/server";
import { clientKey, consume } from "@/lib/rate-limit";

/**
 * Per-request security headers (Next 16 `proxy` convention, formerly
 * `middleware`). The nonce-based Content-Security-Policy is set here — a nonce
 * cannot be a static header. Next reads the nonce from the request-side CSP
 * header and stamps it onto its own inline scripts.
 *
 * CSP posture: default-src 'self'; scripts locked to a per-request nonce +
 * 'strict-dynamic'; frame-ancestors 'none' (clickjacking); object-src 'none'.
 */
/**
 * Same-site check for state-changing requests — the login-CSRF defence.
 *
 * SameSite=Lax does NOT cover this. Lax governs whether an EXISTING cookie is
 * ATTACHED to a cross-site request; it says nothing about a cross-site POST
 * that makes us SET a new cookie. A login endpoint doesn't read an ambient
 * cookie, so Lax protects it not at all.
 *
 * The attack it stops: an attacker auto-submits a form to /api/auth/login
 * carrying THEIR OWN valid id token. `enctype="text/plain"` is CORS-safelisted,
 * so no preflight and no CORS block, and the classic name/value split
 * serialises to valid JSON. The victim's browser stores a session for the
 * ATTACKER's uid; the victim then types their real company and financial data
 * into a tenant the attacker owns. Verification is not the weak point — the
 * token is genuine.
 *
 * Webhooks are exempt because they are legitimately cross-site and are
 * authenticated by an HMAC signature over the raw body instead.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Paths that authenticate themselves with a SECRET rather than with the shape
 * of their headers, and are therefore exempt from the same-site check.
 *
 * ⛔ THE INVARIANT, and it is the whole reason this is a named list rather than
 * a chain of `startsWith` calls: everything here MUST verify a signature or a
 * constant-time shared secret as its first act. Adding a prefix here without
 * that is how a public, unauthenticated mutation endpoint gets created by
 * accident. Both current entries hold: `/api/webhooks/` verifies an HMAC over
 * the raw body; `/api/cron/` compares `x-cron-secret` to CRON_SECRET in
 * constant time.
 *
 * ⛔ `/api/cron/` was MISSING here, and the cost was total: Cloud Scheduler
 * sends neither `Sec-Fetch-Site` nor `Origin`, so every nightly run was
 * refused 403 by this function before the route's own secret check could run.
 * Verified against production 2026-08-23 — 18 consecutive PERMISSION_DENIED
 * attempts, ZERO successes in the 30-day log window. For a month that meant no
 * membership rollovers, no autopay charges, no appointment reminders, no
 * bank-feed syncs and no agent proposals. The comment right below this one
 * already said server-to-server callers "belong in the exemption above" — the
 * cron was simply never added, and nothing tested the shape of a real
 * scheduler request. `crossSiteBlocked` is now pure and directly tested.
 */
const SELF_AUTHENTICATING = ["/api/webhooks/", "/api/cron/"] as const;

/**
 * The same-site decision, as a PURE function over the four things it actually
 * reads. Extracted from `sameSiteViolation` so every branch can be asserted
 * without constructing a NextRequest — the same shape `job-patch.ts` and
 * `stripe-account.ts` use, and the reason this bug went a month undetected is
 * that the decision was previously unreachable from a test.
 */
export function crossSiteBlocked(req: {
  method: string;
  pathname: string;
  secFetchSite: string | null;
  origin: string | null;
  host: string | null;
}): boolean {
  if (SAFE_METHODS.has(req.method)) return false;
  if (SELF_AUTHENTICATING.some((p) => req.pathname.startsWith(p))) return false;

  // Fetch metadata is the strongest signal and is sent by every current
  // browser. "none" = typed in the address bar / bookmark.
  if (req.secFetchSite) {
    return req.secFetchSite !== "same-origin" && req.secFetchSite !== "none";
  }

  // Fallback for clients that omit Fetch metadata: compare Origin to Host.
  // A form POST from another site always carries an Origin.
  if (!req.origin) {
    // Neither signal present: BLOCK. This used to return false — "probably
    // curl, let it through" — which is a default-open decision made on an
    // absence of evidence. Every current browser sends Sec-Fetch-Site, so a
    // state-changing request carrying neither header is either a very old
    // client or something not worth trusting, and the ambient-cookie case
    // (login CSRF) is exactly the one this function exists to stop.
    //
    // Server-to-server callers that legitimately send neither belong in
    // SELF_AUTHENTICATING above, where they are authenticated by a signature
    // or a shared secret rather than by the shape of their headers.
    return true;
  }
  try {
    return new URL(req.origin).host !== req.host;
  } catch {
    return true; // unparseable Origin is not something to reason about
  }
}

function sameSiteViolation(request: NextRequest): boolean {
  return crossSiteBlocked({
    method: request.method,
    pathname: request.nextUrl.pathname,
    secFetchSite: request.headers.get("sec-fetch-site"),
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
  });
}

/**
 * Limits for the unauthenticated edges — the only surfaces reachable without
 * a session, and therefore the only ones a stranger can spend our resources on.
 *
 * Numbers chosen against real use, not round-number instinct: a contractor's
 * customer fills in one booking form, not thirty; a shop signs up once; a
 * person mistypes a password a handful of times, not sixty.
 */
const LIMITS: {
  prefix: string;
  limit: number;
  windowMs: number;
  /**
   * Also limit GET/HEAD. Off by default because a read is cheap and a busy
   * office shares one IP — but a PUBLIC read that runs real queries against a
   * named business is a different thing, and the self-booking slot list is
   * exactly that.
   */
  includeSafe?: boolean;
}[] = [
  // Public booking form. The tenant slug is public (it's in their own booking
  // URL), so this is the one endpoint a stranger can aim at a NAMED business.
  { prefix: "/api/public/intake/", limit: 10, windowMs: 60_000 },
  // Self-booking: the same slug, and the GET computes open slots from real
  // capacity (workers × windows − booked). Limited on reads too.
  { prefix: "/api/public/book/", limit: 20, windowMs: 60_000, includeSafe: true },
  // The customer portal. Unlimited until now, which was an oversight rather
  // than a decision: the token is a 60-day bearer credential in a URL, so a
  // leaked one should not also be an unbounded read of a shop's invoices.
  { prefix: "/api/public/portal/", limit: 60, windowMs: 60_000, includeSafe: true },
  // Each call provisions a tenant AND seeds 478 chart-of-accounts rows.
  { prefix: "/api/auth/signup", limit: 5, windowMs: 60 * 60_000 },
  // The no-login demo mints a session. Generous enough for a real visitor who
  // reloads or shares the link around an office; bounded because anything
  // that mints sessions gets a ceiling.
  { prefix: "/api/demo/start", limit: 20, windowMs: 60_000 },
  // Slow password guessing. Identity Platform rate-limits its own side too;
  // this covers the session-minting half that lives here.
  { prefix: "/api/auth/login", limit: 20, windowMs: 5 * 60_000 },
];

export function proxy(request: NextRequest): NextResponse {
  if (sameSiteViolation(request)) {
    return NextResponse.json(
      { error: { code: "cross_site_request_blocked", message: "cross_site_request_blocked" } },
      { status: 403 },
    );
  }

  // Rate limiting runs after the same-site check (cheaper to reject outright)
  // and only on the unauthenticated edges. Authenticated surfaces are bounded
  // by having a real account behind them; adding a limiter there would mostly
  // punish a busy shop on one office IP.
  const path = request.nextUrl.pathname;
  const rule = LIMITS.find((r) => path.startsWith(r.prefix));
  if (rule && (rule.includeSafe || !SAFE_METHODS.has(request.method))) {
    const { allowed, retryAfter } = consume(
      `${rule.prefix}:${clientKey(request.headers)}`,
      rule,
    );
    if (!allowed) {
      return NextResponse.json(
        { error: { code: "rate_limited", message: "rate_limited" } },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));

  const isDev = process.env.NODE_ENV !== "production";
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    // HMR/eval is only needed by the dev server.
    isDev ? "'unsafe-eval'" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc} https://js.stripe.com`,
    // Stylesheets and <style> elements stay nonce-locked.
    `style-src 'self' 'nonce-${nonce}'`,
    /**
     * ⛔ style ATTRIBUTES are a separate directive, and without this line the
     * application renders wrong in every browser that enforces CSP.
     *
     * A nonce cannot be attached to a `style="…"` attribute — there is nowhere
     * to put it — so a nonce-only `style-src` blocks EVERY inline style. When
     * `style-src-attr` is absent it falls back to `style-src`, which is what
     * was happening here: several hundred React `style={{}}` props across every
     * screen were being parsed and then discarded. Verified in a browser
     * against a live page — the attribute was present in the DOM and
     * `el.style.length` was 0.
     *
     * It does not fail loudly. Class-based layout still works, so pages look
     * *mostly* right and quietly lose their spacing, their progress-bar widths,
     * their skeleton dimensions and their red/green money colours.
     *
     * `style-src-attr 'unsafe-inline'` is the narrow fix, not a loosening of
     * the policy: scripts, stylesheets and <style> blocks are untouched, and
     * the only new capability is setting a style attribute — which requires
     * DOM-injection an attacker does not have, since React escapes everything
     * it renders. The alternative is converting ~370 inline styles to classes,
     * which is a real project and does not make the product any safer.
     */
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.stripe.com",
    "font-src 'self'",
    // identitytoolkit: the browser signs in against Google directly, so the
    // user's password never reaches our servers. That is the whole reason this
    // entry exists — see lib/client/identity.ts.
    "connect-src 'self' https://api.stripe.com https://checkout.stripe.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com",
    // Stripe's embedded checkout runs in an iframe it serves itself.
    "frame-src https://js.stripe.com https://checkout.stripe.com https://hooks.stripe.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "strict-transport-security",
    "max-age=63072000; includeSubDomains; preload",
  );
  response.headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  );
  return response;
}

export const config = {
  // Run on everything except Next's static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
