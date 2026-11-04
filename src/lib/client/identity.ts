"use client";

/**
 * Identity Platform sign-in, straight from the browser to Google.
 *
 * Deliberately NOT proxied through our server, and deliberately not the
 * Firebase SDK:
 *   - Client-direct means the user's PASSWORD never touches our servers. We
 *     cannot log it, dump it, or leak it, because we never hold it. Our server
 *     only ever sees the resulting ID token, which it verifies.
 *   - Raw REST rather than the SDK keeps ~100KB of JS off a page that field
 *     techs open on a phone with one bar of signal.
 *
 * The cost is one CSP connect-src entry for identitytoolkit.googleapis.com,
 * which is a much smaller surface than handling plaintext passwords.
 */

/**
 * Identity Platform splits its REST surface across TWO versions and the docs
 * do not put them on the same page:
 *   v1 — accounts:signInWithPassword
 *   v2 — accounts/mfaEnrollment:*, accounts/mfaSignIn:*
 * Using v1 for the MFA calls returns a 404 that surfaces as a generic failure,
 * which is exactly how TOTP enrollment AND the MFA login challenge both broke
 * silently. The version is per-call for that reason. (Found live 2026-07-26.)
 */
const HOST = "https://identitytoolkit.googleapis.com";

export interface AuthConfig {
  mode: "dev" | "identity-platform";
  configured: boolean;
  apiKey: string | null;
  authDomain: string | null;
}

/** A sign-in that still needs a second factor before it yields an ID token. */
export interface MfaRequired {
  kind: "mfa_required";
  pendingCredential: string;
  /** Enrolled factors the user can choose from (we support TOTP). */
  factors: { enrollmentId: string; displayName?: string }[];
}
export interface SignedIn {
  kind: "signed_in";
  idToken: string;
}
export type SignInResult = SignedIn | MfaRequired;

export class IdentityClientError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/** Google returns machine codes; contractors need sentences. */
function humanize(code: string): string {
  switch (code) {
    case "EMAIL_NOT_FOUND":
    case "INVALID_PASSWORD":
    case "INVALID_LOGIN_CREDENTIALS":
      // One message for all three on purpose: distinguishing "no such email"
      // from "wrong password" hands out a list of who has an account.
      return "That email and password don't match. Try again.";
    case "USER_DISABLED":
      return "This account has been turned off. Give us a call and we'll sort it out.";
    case "TOO_MANY_ATTEMPTS_TRY_LATER":
      return "Too many tries. Wait a few minutes, then try again.";
    case "INVALID_MFA_PENDING_CREDENTIAL":
    case "SESSION_EXPIRED":
      return "That took too long. Start signing in again.";
    case "INVALID_CODE":
    case "INVALID_TOTP_CODE":
      return "That code isn't right. Check your authenticator app and try again.";
    default:
      return "Sign-in didn't work. Try again, or give us a call.";
  }
}

async function post<T>(
  version: "v1" | "v2",
  path: string,
  apiKey: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${HOST}/${version}/${path}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  } & Record<string, unknown>;
  if (!res.ok) {
    const raw = json.error?.message ?? "UNKNOWN";
    // Google appends detail after a space, e.g. "INVALID_CODE : xyz".
    const code = raw.split(/[\s:]/)[0] ?? "UNKNOWN";
    // The user gets a sentence; the console gets the truth. Without this the
    // v1/v2 mix-up above presented as an unexplained "couldn't start setup".
    console.error("[identity] %s /%s/%s -> %d", code, version, path, res.status, raw);
    throw new IdentityClientError(code, humanize(code));
  }
  return json as T;
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  const res = await fetch("/api/auth/config");
  if (!res.ok) throw new IdentityClientError("CONFIG", "Sign-in isn't set up yet.");
  return (await res.json()) as AuthConfig;
}

/** Step 1: email + password. May come back needing a second factor. */
export async function signIn(
  apiKey: string,
  email: string,
  password: string,
): Promise<SignInResult> {
  const r = await post<{
    idToken?: string;
    mfaPendingCredential?: string;
    mfaInfo?: { mfaEnrollmentId: string; displayName?: string }[];
  }>("v1", "accounts:signInWithPassword", apiKey, {
    email,
    password,
    returnSecureToken: true,
  });

  if (r.mfaPendingCredential) {
    return {
      kind: "mfa_required",
      pendingCredential: r.mfaPendingCredential,
      factors: (r.mfaInfo ?? []).map((f) => ({
        enrollmentId: f.mfaEnrollmentId,
        displayName: f.displayName,
      })),
    };
  }
  if (!r.idToken) throw new IdentityClientError("NO_TOKEN", humanize("UNKNOWN"));
  return { kind: "signed_in", idToken: r.idToken };
}

/** Step 2 (when required): finish sign-in with a TOTP code. */
export async function finishMfaSignIn(
  apiKey: string,
  pendingCredential: string,
  enrollmentId: string,
  code: string,
): Promise<string> {
  const r = await post<{ idToken?: string }>("v2", "accounts/mfaSignIn:finalize", apiKey, {
    mfaPendingCredential: pendingCredential,
    mfaEnrollmentId: enrollmentId,
    totpVerificationInfo: { verificationCode: code },
  });
  if (!r.idToken) throw new IdentityClientError("NO_TOKEN", humanize("UNKNOWN"));
  return r.idToken;
}

/** Hand our server the verified token so it can mint the session cookie. */
export async function establishSession(idToken: string): Promise<void> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new IdentityClientError("SESSION", "Sign-in didn't work. Try again.");
}

// ------------------------------------------------------------ TOTP enrollment
export interface TotpEnrollment {
  /** Opaque handle Google needs back when finalising. */
  sessionInfo: string;
  /** The shared secret, for manual entry when a camera won't cooperate. */
  sharedSecretKey: string;
  /** otpauth:// URI for the QR code. */
  qrCodeUrl: string;
}

export async function startTotpEnrollment(
  apiKey: string,
  idToken: string,
): Promise<TotpEnrollment> {
  const r = await post<{
    totpSessionInfo?: {
      sharedSecretKey: string;
      verificationCodeLength: number;
      hashingAlgorithm: string;
      periodSec: number;
      sessionInfo: string;
    };
  }>("v2", "accounts/mfaEnrollment:start", apiKey, { idToken, totpEnrollmentInfo: {} });

  const t = r.totpSessionInfo;
  if (!t) throw new IdentityClientError("NO_SESSION", humanize("UNKNOWN"));
  const issuer = encodeURIComponent("Top Builder OS");
  return {
    sessionInfo: t.sessionInfo,
    sharedSecretKey: t.sharedSecretKey,
    qrCodeUrl: `otpauth://totp/${issuer}?secret=${t.sharedSecretKey}&issuer=${issuer}&algorithm=${t.hashingAlgorithm}&digits=${t.verificationCodeLength}&period=${t.periodSec}`,
  };
}

/**
 * Finish enrolling TOTP. Returns a FRESH id token — the old one predates the
 * second factor and would still verify as aal1, so the caller must re-establish
 * the session with this one to actually reach aal2 surfaces.
 */
export async function finishTotpEnrollment(
  apiKey: string,
  idToken: string,
  sessionInfo: string,
  code: string,
  displayName: string,
): Promise<string> {
  const r = await post<{ idToken?: string }>("v2", "accounts/mfaEnrollment:finalize", apiKey, {
    idToken,
    displayName,
    totpVerificationInfo: { sessionInfo, verificationCode: code },
  });
  if (!r.idToken) throw new IdentityClientError("NO_TOKEN", humanize("UNKNOWN"));
  return r.idToken;
}
