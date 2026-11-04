/**
 * A no-op stand-in for the `server-only` package, for PROOF SCRIPTS ONLY.
 *
 * `server-only` throws on import outside a server component, which is exactly
 * what you want in the app and exactly what stops a plain node script from
 * exercising a server module directly.
 *
 * It is wired in `scripts/tsconfig.proof.json` — a separate tsconfig the app
 * build never reads — so this cannot weaken the real guard. The alternative
 * was proving the streamed export only through HTTP, which cannot reach it:
 * the route demands a second factor a dev login cannot produce.
 */
export {};
