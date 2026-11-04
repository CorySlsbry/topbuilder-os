"use client";
import { useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/client/api";

/**
 * Ask your books.
 *
 * ⛔ THE CITATIONS STRIP IS NOT DECORATION. Every answer names the reports it
 * came from and links to the screen that produced each one, so a person can
 * always go and check. That is the trust mechanism, and it costs nothing.
 *
 * ⛔ NO `useFirstLoad` HERE, deliberately. That hook LATCHES — it shows a
 * skeleton once per visit and never again — which is exactly right for a page
 * load and exactly wrong for this: thinking has to be visible on EVERY
 * question, not just the first one. Documented so nobody "fixes" it.
 */
export default function AskBooks() {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{
    answer: string;
    citations: { tool: string; args: Record<string, unknown>; href: string }[];
    usedFallback: boolean;
    note: string;
  } | null>(null);
  const [error, setError] = useState("");

  async function ask() {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setError("");
    setAnswer(null);
    try {
      setAnswer(await api("/api/assist/books", { method: "POST", json: { question: q } }));
    } catch (e) {
      setError(
        e instanceof ApiError && e.code?.startsWith("books_qa_rate_limited")
          ? "That's a lot of questions this hour — give it a few minutes."
          : "Couldn't answer that right now. The reports themselves are all still there.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Ask your books</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        A plain question about your own numbers. Every answer says which reports
        it came from, so you can go and check it.
      </p>

      <label htmlFor="books-q" className="sr-only">Your question</label>
      <input
        id="books-q"
        value={question}
        onChange={(e) => setQuestion(e.target.value.slice(0, 500))}
        onKeyDown={(e) => e.key === "Enter" && void ask()}
        placeholder="How's my cash looking for the next month?"
        disabled={busy}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => void ask()} disabled={busy || !question.trim()}>
          {busy ? "Looking it up…" : "Ask"}
        </button>
      </div>

      <div aria-live="polite">
        {error && <p className="error">{error}</p>}

        {answer && (
          <div style={{ marginTop: 12 }}>
            <p style={{ whiteSpace: "pre-wrap", marginBottom: 6 }}>{answer.answer}</p>

            {answer.usedFallback && answer.note && (
              // Said out loud rather than hidden. A person deserves to know
              // when they are reading the report's own wording because the
              // summary used a figure we couldn't trace.
              <p className="muted" style={{ fontSize: "0.82rem", marginTop: 0 }}>
                {answer.note}
              </p>
            )}

            {answer.citations.length > 0 && (
              <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                <span className="muted" style={{ fontSize: "0.8rem" }}>From:</span>
                {answer.citations.map((c, i) => (
                  <Link key={i} href={c.href} className="pill" style={{ textDecoration: "none" }}>
                    {c.tool.replace(/_/g, " ")}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
