// The figure-faithfulness firewall — the TERMINAL gate on any text that
// quotes money or quantities (ported from ServiceTitan Agent Platform
// ADR-0003). Deterministic, sub-millisecond, no model involved:
// every numeric token in a draft must be a normalized verbatim match to an
// authoritative figure, or the draft is replaced by a template built from
// the authoritative figures themselves. Even a fully hallucinated narrative
// cannot ship a wrong number.

export interface FigureCheck {
  ok: boolean;
  /** Numeric tokens in the draft with no authoritative match. */
  violations: string[];
}

/**
 * Pull numeric tokens from text: $1,234.56 / 1234.56 / 9,000 / 42 / 19.95%.
 * Ignores date-like tokens (2026-07-24, 07/24/2026) and identifiers glued
 * to letters (job #1, INV-1001), which are references, not figures.
 */
export function extractNumericTokens(text: string): string[] {
  const cleaned = text
    // ISO + US dates are references, not figures.
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " ")
    // Identifiers: #123, INV-1001, X999 — glued to a marker or letters.
    .replace(/#\d+\b/g, " ")
    .replace(/\b[A-Za-z]+[-_]?\d+\b/g, " ");
  const m = cleaned.match(/\$?\d[\d,]*(?:\.\d+)?%?/g);
  return m ?? [];
}

/** "$1,234.50" / "1,234.5" / "1234.50" -> canonical "1234.5". */
export function normalizeNumber(token: string): string {
  const bare = token.replace(/[$,%\s]/g, "").replace(/,/g, "");
  const n = Number(bare);
  if (!Number.isFinite(n)) return token;
  return String(n);
}

/**
 * Verify a draft against the authoritative figures. `figures` are the ONLY
 * numbers the draft may contain (cents get supplied both as cents and as
 * dollars by figureUniverse below).
 */
export function verifyFigures(draft: string, allowed: (string | number)[]): FigureCheck {
  const allowedSet = new Set(allowed.map((f) => normalizeNumber(String(f))));
  const violations = extractNumericTokens(draft)
    .map(normalizeNumber)
    .filter((t) => !allowedSet.has(t));
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

/**
 * Expand authoritative cent amounts into every representation a summary may
 * legitimately quote: cents, dollars (1234.5), and whole-dollar form.
 */
export function figureUniverse(figures: (string | number)[]): (string | number)[] {
  const out: (string | number)[] = [];
  for (const f of figures) {
    out.push(f);
    const n = Number(f);
    if (Number.isSafeInteger(n)) {
      out.push(n / 100); // cents -> dollars
      if (n % 100 === 0) out.push(n / 100); // whole dollars
    }
  }
  return out;
}
