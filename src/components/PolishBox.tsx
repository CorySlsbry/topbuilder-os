"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/client/api";

/**
 * The polish helper, everywhere it appears.
 *
 * ⛔ THE CONTRACT THIS COMPONENT EXISTS TO HOLD: **it never replaces what you
 * typed.** It shows the rewrite beside the original and a person picks. Not
 * "usually", not "unless the box is small" — never.
 *
 * That is why this is one component rather than a hook or a helper each screen
 * wires up itself. The contract is a UI property, so it has to live in UI code,
 * in one place. With four copies, one of them eventually swaps the text in
 * place because auto-replace is simpler to write — and the copy that does it
 * will be the one attached to a price, because that is the surface somebody was
 * in a hurry on. `polish-single-caller.test.ts` fails the build if a screen
 * calls the endpoint directly.
 *
 * Everything else follows from the same idea:
 * - The button is the ONLY thing that calls the model. It does not fire on
 *   blur, on typing, or on save.
 * - A failure of any kind leaves the draft exactly as it was and says so in a
 *   sentence. The helper can never make a message worse than the typed one.
 * - "Use this" is an explicit click. "Keep mine" is always available and is
 *   never the smaller button.
 */

export type PolishSurface =
  | "reply"
  | "estimate"
  | "invoice_memo"
  | "dunning"
  | "review_request"
  | "outreach"
  | "note";

export type PolishTone = "professional" | "friendly" | "shorter";

const TONES: { key: PolishTone; label: string }[] = [
  { key: "professional", label: "Professional" },
  { key: "friendly", label: "Friendly" },
  { key: "shorter", label: "Shorter" },
];

export default function PolishBox({
  text,
  surface,
  onUse,
  tone: initialTone = "professional",
  label = "Polish this",
  disabled = false,
  showTone = true,
}: {
  /** The words the person has typed right now. */
  text: string;
  /** Where they are going — picks the prompt rule and the escalation gate. */
  surface: PolishSurface;
  /** Called ONLY when the person clicks "Use this". */
  onUse: (polished: string) => void;
  /** Starting style. The person can change it; the component owns it after. */
  tone?: PolishTone;
  label?: string;
  disabled?: boolean;
  /** Hide the style picker where one style is obviously right — a one-line
   *  invoice memo does not need a "friendly" option. */
  showTone?: boolean;
}) {
  const [tone, setTone] = useState<PolishTone>(initialTone);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toneId = `polish-tone-${surface}`;

  async function run() {
    const draft = text.trim();
    if (!draft) return;
    setBusy(true);
    setNote("");
    try {
      const r = await api<{ polished: string; changed: boolean; note: string }>(
        "/api/assist/polish",
        { method: "POST", json: { text: draft, tone, surface } },
      );
      if (!r.changed) {
        setSuggestion(null);
        setNote(r.note || "That already reads well — nothing to change.");
      } else {
        setSuggestion(r.polished);
        setNote(r.note);
      }
    } catch (e) {
      // Every failure path ends the same way: the draft is untouched, and the
      // person is told in one sentence. No provider errors, no stack, no retry
      // loop that quietly spends a shop's tokens.
      setSuggestion(null);
      setNote(
        e instanceof ApiError && e.code === "polish_rate_limited"
          ? "You've polished a lot this hour — give it a few minutes. Your wording is untouched."
          : "The polish helper isn't available right now. Your wording is untouched.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div className="row">
        <button
          type="button"
          className="secondary"
          onClick={() => void run()}
          disabled={busy || disabled || !text.trim()}
        >
          {busy ? "Polishing…" : label}
        </button>
        {showTone && (
          <>
            <label htmlFor={toneId} className="sr-only">
              Polish style
            </label>
            <select
              id={toneId}
              value={tone}
              onChange={(e) => setTone(e.target.value as PolishTone)}
              disabled={busy || disabled}
            >
              {TONES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {/* Announced, because the result appears below the button and a screen
          reader user would otherwise never learn it arrived. */}
      <div aria-live="polite">
        {note && (
          <p className="muted" style={{ marginBottom: 0 }}>
            {note}
          </p>
        )}

        {suggestion && (
          <div className="card" style={{ marginTop: 8 }}>
            <div className="muted" style={{ marginBottom: 4 }}>
              Suggested rewrite — your version is still in the box above.
            </div>
            <p style={{ whiteSpace: "pre-wrap", marginTop: 0 }}>{suggestion}</p>
            <div className="row">
              <button
                type="button"
                onClick={() => {
                  onUse(suggestion);
                  setSuggestion(null);
                  setNote("");
                }}
              >
                Use this
              </button>
              {/* Deliberately the same weight as "Use this". A smaller or
                  quieter "keep mine" is a dark pattern wearing a button. */}
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setSuggestion(null);
                  setNote("");
                }}
              >
                Keep mine
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
