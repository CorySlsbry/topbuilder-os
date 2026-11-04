"use client";
import { useId } from "react";

/**
 * Hand-rolled SVG charts.
 *
 * ⛔ NO CHARTING LIBRARY, AND THIS IS NOT A PREFERENCE. The app's CSP is
 * `script-src 'self' 'nonce-…'`, which blocks every CDN script — Chart.js,
 * Recharts, everything — and most charting libraries also inject un-nonced
 * inline <style> blocks that die the same way. Crucially they die IN
 * PRODUCTION ONLY, because dev builds relax the policy; this codebase has
 * eaten that exact failure once already.
 *
 * SVG with presentation ATTRIBUTES (fill=, stroke=) rather than style=""
 * needs nothing from the CSP at all. It also means these charts are real DOM
 * — a screen reader can be told what they say, they print, and they scale to
 * a phone without a resize listener.
 *
 * ── EVERY CHART CARRIES ITS NUMBERS IN TEXT ──────────────────────────────
 * A chart is a summary of a table, never a replacement for one. Each one
 * takes an `alt` sentence that states the finding in words, so the screen is
 * usable at 400% zoom, by a screen reader, and by somebody glancing at it on
 * a phone in a truck. That is a WCAG requirement and also just better.
 */

export interface Point {
  label: string;
  value: number;
}

const PAD = { top: 12, right: 8, bottom: 22, left: 8 };

function niceMax(values: number[]): number {
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const mag = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / mag) * mag;
}

/**
 * A column chart. Used for anything counted or totalled per period —
 * revenue by month, jobs closed by week.
 */
export function BarChart({
  points,
  alt,
  height = 160,
  format = (n) => String(n),
  highlightNegative = true,
}: {
  points: Point[];
  alt: string;
  height?: number;
  format?: (n: number) => string;
  highlightNegative?: boolean;
}) {
  const id = useId();
  if (points.length === 0) {
    return <p className="muted">Nothing to chart yet.</p>;
  }
  const w = 100; // viewBox units; the SVG scales to its container
  const inner = height - PAD.top - PAD.bottom;
  const max = niceMax(points.map((p) => p.value));
  const hasNeg = points.some((p) => p.value < 0);
  const zeroY = hasNeg ? PAD.top + inner / 2 : PAD.top + inner;
  const scale = hasNeg ? inner / 2 / max : inner / max;
  const slot = w / points.length;
  const barW = Math.max(1, slot * 0.62);

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-labelledby={`${id}-t`}
        preserveAspectRatio="none"
      >
        <title id={`${id}-t`}>{alt}</title>
        <line
          x1="0" y1={zeroY} x2={w} y2={zeroY}
          stroke="var(--line)" strokeWidth="0.4" vectorEffect="non-scaling-stroke"
        />
        {points.map((p, i) => {
          const h = Math.abs(p.value) * scale;
          const x = i * slot + (slot - barW) / 2;
          const y = p.value >= 0 ? zeroY - h : zeroY;
          const negative = highlightNegative && p.value < 0;
          return (
            <rect
              key={p.label}
              x={x} y={y} width={barW} height={Math.max(0.5, h)}
              fill={negative ? "var(--danger)" : "var(--brand)"}
              rx="0.8"
            />
          );
        })}
      </svg>
      {/* The numbers themselves, always. A chart is a summary of a table. */}
      <figcaption className="muted" style={{ marginTop: 4 }}>
        {alt}
      </figcaption>
      <div className="row" style={{ gap: 12, flexWrap: "wrap", marginTop: 2 }}>
        {points.map((p) => (
          <span key={p.label} className="muted" style={{ fontSize: "0.75rem" }}>
            {p.label} {format(p.value)}
          </span>
        ))}
      </div>
    </figure>
  );
}

/**
 * A line with an optional FLOOR. Built for the cash forecast, where the
 * whole point is the week the line goes under the number the owner has to
 * keep in the bank — so the floor is a first-class input, not a decoration.
 */
export function LineChart({
  points,
  alt,
  floor,
  floorLabel = "floor",
  height = 170,
  format = (n) => String(n),
}: {
  points: Point[];
  alt: string;
  floor?: number;
  floorLabel?: string;
  height?: number;
  format?: (n: number) => string;
}) {
  const id = useId();
  if (points.length < 2) {
    return <p className="muted">Not enough weeks yet to draw a line.</p>;
  }
  const w = 100;
  const inner = height - PAD.top - PAD.bottom;
  const values = points.map((p) => p.value);
  if (floor !== undefined) values.push(floor);
  const lo = Math.min(0, ...values);
  const hi = Math.max(...values, 1);
  const span = hi - lo || 1;
  const y = (v: number) => PAD.top + inner - ((v - lo) / span) * inner;
  const x = (i: number) => (i / (points.length - 1)) * w;

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.value)}`).join(" ");
  const breaches = floor === undefined ? [] : points.filter((p) => p.value < floor);

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-labelledby={`${id}-t`}
        preserveAspectRatio="none"
      >
        <title id={`${id}-t`}>{alt}</title>
        {floor !== undefined && (
          <>
            <line
              x1="0" y1={y(floor)} x2={w} y2={y(floor)}
              stroke="var(--danger)" strokeWidth="0.5" strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
            {/* Every week BELOW the floor gets a marker, because "it dips in
                week 6" is the entire message of this chart. */}
            {points.map((p, i) =>
              p.value < floor ? (
                <circle key={p.label} cx={x(i)} cy={y(p.value)} r="1.6" fill="var(--danger)" />
              ) : null,
            )}
          </>
        )}
        <path
          d={path}
          fill="none"
          stroke="var(--brand)"
          strokeWidth="1.6"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="muted" style={{ marginTop: 4 }}>
        {alt}
        {floor !== undefined && breaches.length > 0 && (
          <>
            {" "}
            <strong>
              Below the {floorLabel} in {breaches.length} week
              {breaches.length === 1 ? "" : "s"}: {breaches.map((b) => b.label).join(", ")}.
            </strong>
          </>
        )}
      </figcaption>
      <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 2 }}>
        {points.map((p) => (
          <span key={p.label} className="muted" style={{ fontSize: "0.72rem" }}>
            {p.label} {format(p.value)}
          </span>
        ))}
      </div>
    </figure>
  );
}

/**
 * A single proportion bar — "you have used 62% of your line of credit",
 * "38% of jobs have a signed form". Reads as a sentence with a picture, not
 * a picture that needs decoding.
 */
export function ProgressBar({
  value,
  max,
  label,
  danger = false,
}: {
  value: number;
  max: number;
  label: string;
  danger?: boolean;
}) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted">{label}</span>
        <strong>{pct}%</strong>
      </div>
      <svg viewBox="0 0 100 6" width="100%" height="6" role="img" aria-label={`${label}: ${pct}%`}>
        <rect x="0" y="0" width="100" height="6" fill="var(--line-soft)" rx="3" />
        <rect
          x="0" y="0" width={pct} height="6" rx="3"
          fill={danger ? "var(--danger)" : "var(--brand)"}
        />
      </svg>
    </div>
  );
}
