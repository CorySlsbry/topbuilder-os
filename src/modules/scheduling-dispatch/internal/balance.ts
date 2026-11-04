// Least-loaded worker choice — pure, deterministic. Ties break by name so
// the same inputs always produce the same assignment (auditable, testable).

export interface Candidate {
  workerId: string;
  name: string;
}

export function pickLeastLoaded(
  candidates: Candidate[],
  loadByWorkerId: Map<string, number>,
): Candidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const la = loadByWorkerId.get(a.workerId) ?? 0;
    const lb = loadByWorkerId.get(b.workerId) ?? 0;
    return la - lb || a.name.localeCompare(b.name) || a.workerId.localeCompare(b.workerId);
  })[0]!;
}
