// Pure learning helpers (no DB, no server-only) — testable in isolation.

/** Deterministic CIPHER-style rule text from a human edit (field diffs). */
export function distillPreference(
  proposal: Record<string, unknown>,
  edit: Record<string, unknown>,
): string | null {
  const changes: string[] = [];
  for (const [k, v] of Object.entries(edit)) {
    const before = proposal[k];
    if (JSON.stringify(before) !== JSON.stringify(v)) {
      changes.push(`prefer ${k}=${JSON.stringify(v)} over ${JSON.stringify(before ?? null)}`);
    }
  }
  if (changes.length === 0) return null;
  return `When proposing similar actions: ${changes.join("; ")}.`;
}
