import "server-only";
import { z } from "zod";

/**
 * Runtime environment validation. Parsed lazily (on first `env()` call) rather
 * than at import time, so `next build` never requires DB/secret values — build
 * secrets are supplied at deploy, not bake time.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // App-connection DSN (non-superuser app role in prod). Optional at build.
  DATABASE_URL: z.string().url().optional(),
  // Public base URL of the deployed app (used for absolute links, webhooks).
  APP_URL: z.string().url().default("http://localhost:3000"),
  /**
   * Origin used to build Stripe return URLs (checkout success/cancel, billing
   * portal, customer payment links).
   *
   * Declared here because it was previously read straight from process.env in
   * three places with a `?? "http://localhost:5150"` fallback and appeared in
   * no schema, no .env.example and no docs. It IS set correctly on Cloud Run
   * today — but nothing would have caught it being dropped, and the failure
   * mode is silent and awful: a paying customer redirected to localhost after
   * handing over a card.
   */
  APP_ORIGIN: z.string().url().default("http://localhost:5150"),
  /**
   * Auth provider. "dev" = local email-only login (NEVER in production —
   * enforced in code); "identity-platform" = GCP Identity Platform ID-token
   * verification + TOTP (requires GCP provisioning; see docs/NEEDS-CORY.md).
   */
  AUTH_MODE: z.enum(["dev", "identity-platform"]).default("dev"),
  /** iron-session cookie encryption secret (>=32 chars). Required in prod. */
  SESSION_SECRET: z.string().min(32).optional(),
  /**
   * GCP project that mints Identity Platform ID tokens. Required when
   * AUTH_MODE=identity-platform: it is BOTH the expected `iss` suffix and the
   * expected `aud`. Without the aud check, a token minted for any other
   * Firebase project verifies against the same Google keys and would be
   * accepted — so this is a security control, not just configuration.
   */
  GCP_PROJECT_ID: z.string().min(1).optional(),
  /**
   * Identity Platform Web API key. NOT a secret (it identifies the project to
   * Google's auth endpoints; it grants nothing on its own) — but it is still
   * served at runtime rather than NEXT_PUBLIC_-baked, so the same key rotation
   * story applies to it as to the Stripe publishable key.
   */
  IDENTITY_PLATFORM_API_KEY: z.string().min(1).optional(),
}).superRefine((e, ctx) => {
  // Defaults that are correct in dev and dangerous in production. A localhost
  // APP_ORIGIN in prod means Stripe sends a customer who just paid to a page
  // that does not exist — and nothing else in the system would notice.
  if (e.NODE_ENV === "production" && new URL(e.APP_ORIGIN).hostname === "localhost") {
    ctx.addIssue({
      code: "custom",
      path: ["APP_ORIGIN"],
      message: "APP_ORIGIN must be the real public origin in production",
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | undefined;

export function env(): Env {
  if (!_env) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      // Never print values — only which keys failed.
      const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid environment configuration: ${keys}`);
    }
    _env = parsed.data;
  }
  return _env;
}

export function requireDatabaseUrl(): string {
  const url = env().DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}
