"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A signature pad, hand-rolled in about a hundred lines.
 *
 * No dependency, for the usual reason in this codebase: the CSP forbids
 * un-nonced inline styles, and most drawing libraries inject them. But mostly
 * because the hard parts of a signature pad are four specific bugs, and a
 * library does not save you from the one that matters — the fallback.
 *
 * ⛔ 1. `touch-action: none`. Without it, the FIRST stroke scrolls the page
 *       instead of drawing. This is the number-one failure of hand-rolled
 *       pads: it works perfectly with a mouse and is unusable on the phone
 *       the customer is actually holding.
 * ⛔ 2. POINTER events, not touch + mouse. One code path covers finger,
 *       stylus and mouse; two code paths mean the stylus works and the glove
 *       does not.
 * ⛔ 3. A DPR-SCALED backing store. A canvas sized in CSS pixels on a 3x
 *       phone stores a third of the resolution, and the signature that lands
 *       on the PDF looks like a fax of a fax.
 * ⛔ 4. Quadratic midpoint smoothing. Straight segments between raw points
 *       turn ordinary handwriting into a polygon.
 *
 * And the one that is not a rendering problem at all:
 *
 *   THE TYPED-NAME FALLBACK IS NOT OPTIONAL. A drawn squiggle must never be
 *   the only way to complete a required field. Arthritis, a stylus that
 *   walked off, a cracked screen, work gloves — the person holding the phone
 *   did not choose the form, and a required field they physically cannot
 *   fill is a job that cannot be closed.
 *
 * Output is a PNG data URL. `image/svg+xml` is NOT in `isAllowedUpload` —
 * correctly, because SVG is a script-execution vector — so a vector pad would
 * have had nowhere to send its result.
 */

export default function SignaturePad({
  onDrawn,
  onTyped,
  disabled = false,
  height = 160,
}: {
  /** A finished drawing, as a PNG data URL. Fires on pointer-up, not on every point. */
  onDrawn: (pngDataUrl: string) => void;
  /** The typed-name fallback. Always available, never hidden behind "advanced". */
  onTyped: (name: string) => void;
  disabled?: boolean;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const mid = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const [typed, setTyped] = useState("");

  /** Size the backing store to the device, not to CSS pixels. */
  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1a202c";
  }, []);

  useEffect(() => {
    fit();
    // A rotation changes the backing store size and would otherwise stretch
    // whatever is already drawn. Refitting clears it, which is the honest
    // behaviour: the alternative is a distorted signature nobody agreed to.
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);

  function pointOf(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    // Capture, so a stroke that leaves the canvas mid-signature keeps drawing
    // instead of stopping dead at the edge.
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = pointOf(e);
    last.current = p;
    mid.current = p;
    setHasInk(true);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || disabled) return;
    const ctx = canvasRef.current?.getContext("2d");
    const from = last.current;
    const m0 = mid.current;
    if (!ctx || !from || !m0) return;
    const p = pointOf(e);
    // Quadratic through the midpoints: the previous point becomes the control
    // point, so the curve passes smoothly between samples instead of turning
    // handwriting into a polygon.
    const m1 = { x: (from.x + p.x) / 2, y: (from.y + p.y) / 2 };
    ctx.beginPath();
    ctx.moveTo(m0.x, m0.y);
    ctx.quadraticCurveTo(from.x, from.y, m1.x, m1.y);
    ctx.stroke();
    last.current = p;
    mid.current = m1;
  }

  function end(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    mid.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const canvas = canvasRef.current;
    // Fires once per stroke, not per point: a data URL per pointermove would
    // be tens of megabytes of base64 through React state on a phone.
    if (canvas) onDrawn(canvas.toDataURL("image/png"));
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        aria-label="Signature area — draw with a finger, a stylus or a mouse"
        style={{
          width: "100%",
          height,
          border: "1px dashed var(--line, #cbd5e0)",
          borderRadius: 8,
          background: "#fff",
          // ⛔ The single most important line in this file. Without it the
          // first stroke scrolls the page instead of drawing.
          touchAction: "none",
          cursor: disabled ? "not-allowed" : "crosshair",
        }}
      />
      <div className="row" style={{ marginTop: 6, alignItems: "center" }}>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {hasInk ? "Signed above." : "Sign above with your finger."}
        </span>
        <span className="grow" />
        <button type="button" className="secondary" onClick={clear} disabled={disabled}>
          Clear
        </button>
      </div>

      {/* Always visible, never behind a "can't sign?" link. A required field
          that only a working motor path can fill is a job nobody can close. */}
      <div style={{ marginTop: 8 }}>
        <label htmlFor="signed-name">Or type your name instead</label>
        <input
          id="signed-name"
          value={typed}
          disabled={disabled}
          onChange={(e) => setTyped(e.target.value.slice(0, 120))}
          onBlur={() => onTyped(typed.trim())}
          placeholder="Dana Rivera"
        />
      </div>
    </div>
  );
}
