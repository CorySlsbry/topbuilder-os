"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";

/**
 * The front door of the no-login tour.
 *
 * Why a page rather than the marketing site POSTing directly: the CSRF guard
 * in proxy.ts is fail-closed, so a cross-origin POST from topbuilderai.com is
 * refused — correctly. Landing here first makes the session mint SAME-ORIGIN
 * and keeps that guard intact, which is worth far more than saving a redirect.
 *
 * Lands on /jobs on purpose: the marketing hero promises "know what every job
 * made you", so the first screen after the click had better be the jobs and
 * their margins. Delivering the exact promise beats showing off a dashboard.
 */
export default function DemoPage() {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        await api("/api/demo/start", { method: "POST" });
        router.replace("/jobs");
      } catch (e) {
        setError(
          e instanceof ApiError && e.status === 429
            ? "The demo is busy at the moment — give it a minute and try again."
            : "The demo isn't available right now. Try again shortly, or book a call and we'll walk you through it live.",
        );
      }
    })();
  }, [router]);

  return (
    <main className="shell" style={{ maxWidth: 620, paddingTop: 80 }}>
      {error ? (
        <>
          <h1>Hmm.</h1>
          <p>{error}</p>
          <p>
            <a href="https://topbuilderai.com">← Back to Top Builder</a>
          </p>
        </>
      ) : (
        <>
          <h1>Opening the demo…</h1>
          <p className="muted">
            Setting you up with a read-only seat at Desert Aire Mechanical — a
            made-up 11-person HVAC shop running on the real product.
          </p>
        </>
      )}
    </main>
  );
}
