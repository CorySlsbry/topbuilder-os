"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import {
  establishSession,
  fetchAuthConfig,
  finishMfaSignIn,
  signIn as identitySignIn,
  IdentityClientError,
  type AuthConfig,
  type MfaRequired,
} from "@/lib/client/identity";

interface Me {
  memberships: { tenantId: string; tenantName: string }[];
}

type Stage = "credentials" | "mfa" | "company";

export default function LoginPage() {
  const router = useRouter();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [stage, setStage] = useState<Stage>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<MfaRequired | null>(null);
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchAuthConfig()
      .then(setCfg)
      .catch(() => setCfg({ mode: "dev", configured: false, apiKey: null, authDomain: null }));
  }, []);

  /** Shared tail: a session exists — go to the shop, or name it first. */
  const afterSession = useCallback(async () => {
    const me = await api<Me>("/api/me");
    if (me.memberships.length === 0) {
      setStage("company"); // fresh start — no sample data to delete later
      return;
    }
    await api("/api/auth/select-tenant", {
      method: "POST",
      json: { tenantId: me.memberships[0]!.tenantId },
    });
    router.push("/jobs");
  }, [router]);

  async function submitCredentials() {
    if (!cfg) return;
    setBusy(true);
    setError("");
    try {
      if (cfg.mode === "dev") {
        await api("/api/auth/dev-login", { method: "POST", json: { email } });
        await afterSession();
        return;
      }
      if (!cfg.configured || !cfg.apiKey) {
        setError("Sign-in isn't switched on yet. Give us a call and we'll get you in.");
        return;
      }
      const result = await identitySignIn(cfg.apiKey, email.trim(), password);
      if (result.kind === "mfa_required") {
        setPending(result);
        setStage("mfa");
        return;
      }
      await establishSession(result.idToken);
      await afterSession();
    } catch (e) {
      setError(e instanceof IdentityClientError ? e.message : "Sign-in didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    if (!cfg?.apiKey || !pending) return;
    setBusy(true);
    setError("");
    try {
      const factor = pending.factors[0];
      if (!factor) throw new IdentityClientError("NO_FACTOR", "No second factor is set up.");
      const idToken = await finishMfaSignIn(
        cfg.apiKey,
        pending.pendingCredential,
        factor.enrollmentId,
        code.trim(),
      );
      await establishSession(idToken);
      await afterSession();
    } catch (e) {
      setError(e instanceof IdentityClientError ? e.message : "That code didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function createCompany() {
    setBusy(true);
    setError("");
    try {
      const slug = company
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 30);
      await api("/api/auth/signup", { method: "POST", json: { name: company, slug } });
      router.push("/jobs");
    } catch {
      setError("Couldn't create the company. Try a different name.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <h1>Top Builder OS</h1>

      {stage === "credentials" && (
        <div className="card">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person1@example.com"
            autoComplete="username"
            onKeyDown={(e) => e.key === "Enter" && cfg?.mode === "dev" && void submitCredentials()}
          />
          {cfg?.mode === "identity-platform" && (
            <>
              <label htmlFor="password" style={{ marginTop: 12, display: "block" }}>
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                onKeyDown={(e) => e.key === "Enter" && void submitCredentials()}
              />
            </>
          )}
          <div style={{ marginTop: 12 }}>
            <button
              onClick={() => void submitCredentials()}
              disabled={busy || !email || (cfg?.mode === "identity-platform" && !password)}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
          {cfg?.mode === "dev" && (
            <p className="muted" style={{ marginTop: 10 }}>
              Dev sign-in (email only). Production uses a password plus 2-step
              verification.
            </p>
          )}
        </div>
      )}

      {stage === "mfa" && (
        <div className="card">
          <h2>One more step</h2>
          <p className="muted">
            Open your authenticator app and type the 6-digit code for Top Builder OS.
          </p>
          <label htmlFor="code">6-digit code</label>
          <input
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            onKeyDown={(e) => e.key === "Enter" && code.length === 6 && void submitCode()}
          />
          <div style={{ marginTop: 12 }}>
            <button onClick={() => void submitCode()} disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Verify"}
            </button>
          </div>
        </div>
      )}

      {stage === "company" && (
        <div className="card">
          <h2>Welcome! Name your company</h2>
          <p className="muted">
            You start with a clean slate — no sample data to delete later.
          </p>
          <label htmlFor="company">Company name</label>
          <input
            id="company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Desert Aire Mechanical"
            onKeyDown={(e) => e.key === "Enter" && company.trim() && void createCompany()}
          />
          <div style={{ marginTop: 12 }}>
            <button onClick={() => void createCompany()} disabled={busy || !company.trim()}>
              {busy ? "Creating…" : "Create company"}
            </button>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </main>
  );
}
