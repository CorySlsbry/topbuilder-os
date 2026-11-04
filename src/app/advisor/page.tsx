"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Membership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: string;
}

// S21 — the Advisor Console (free, the CPA channel). A CPA with invites
// from several shops sees every client here, switches in one click, and
// lands on the same books the owner sees — plus the pack, exports, and
// period locks. Free the way QBOA is free: the CPA is the salesperson.
export default function AdvisorPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loaded, setLoaded] = useState(false);
  // First paint only — the latch means a save never re-flashes the screen.
  const showAdvisorSkeleton = useFirstLoad(loaded);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api<{ memberships: Membership[] }>("/api/advisor");
      setMemberships(r.memberships);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push("/login");
      else setError("Couldn't load your clients.");
    } finally {
      // finally, not the try: an error must still end the wireframe, or a
      // failed load leaves a skeleton shimmering forever.
      setLoaded(true);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function redeem() {
    setBusy(true);
    setError("");
    try {
      await api("/api/advisor", { method: "POST", json: { action: "redeem", code: code.trim() } });
      setNote("You're in — the client is now on your list.");
      setCode("");
      await load();
    } catch {
      setError("That code isn't valid (or was already used).");
    } finally {
      setBusy(false);
    }
  }

  async function open(tenantId: string) {
    setBusy(true);
    try {
      await api("/api/auth/select-tenant", { method: "POST", json: { tenantId } });
      router.push("/reports");
    } catch {
      setError("Couldn't open that client.");
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <main className="shell">
        <h1>Advisor console</h1>
        {showAdvisorSkeleton && <PageSkeleton kind="list" />}
      </main>
    );
  }

  return (
    <main className="shell">
      <h1>Advisor console</h1>
      <p className="muted">
        Every client, one login. Open a client to see the same books they
        see — statements, the CPA pack, exports, and month locks. Free,
        forever, because your workflow shouldn&apos;t cost your client money.
      </p>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Your clients</h2>
        {memberships.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No clients yet — redeem an invite code below.
          </p>
        ) : (
          memberships.map((m) => (
            <div className="row" key={m.tenantId}>
              <span className="grow">
                <strong>{m.tenantName}</strong>{" "}
                <span className="pill">{m.role}</span>
              </span>
              <button disabled={busy} onClick={() => void open(m.tenantId)}>
                Open books →
              </button>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Add a client</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Ask the owner to make you an invite code (Accountant page →
          &quot;Invite my CPA&quot;), then paste it here.
        </p>
        <div className="row">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="invite code"
            aria-label="Invite code"
            className="grow"
          />
          <button disabled={busy || !code.trim()} onClick={() => void redeem()}>
            Join client
          </button>
        </div>
      </div>

      <p className="muted">
        <Link href="/login">Sign in</Link> first if your list looks empty.
      </p>
      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
    </main>
  );
}
