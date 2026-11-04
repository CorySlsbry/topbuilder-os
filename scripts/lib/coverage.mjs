/**
 * Route-coverage attribution for the endpoint sweep.
 *
 * Extracted from scripts/endpoint-sweep.mjs so it can be unit-tested. The
 * sweep itself is a script with top-level side effects — importing it from a
 * test would run the whole sweep — and this is the one piece of it whose
 * correctness is not self-evident from watching the output.
 *
 * ⛔ The bug this replaces: the sweep GUESSED which called segments were route
 * params by testing each against a uuid-shaped regex, then compared the guess
 * to route names built from real FILE paths. Those contain `[slug]` and
 * `[token]` — never `[id]` — so a called path could never match them and they
 * could never be marked covered. It went unnoticed because every such route
 * happened to be EXEMPT, and exempt routes skip the comparison entirely. The
 * coverage gate had a blind spot exactly the size of "any dynamic segment not
 * named id", which is precisely where the next public endpoint was going.
 */

/** "/api/jobs/abc?x=1" -> "api/jobs/abc" */
export function bare(path) {
  return path.split("?")[0].replace(/^\//, "");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDynamic(segment) {
  return /^\[.+\]$/.test(segment);
}

/**
 * Attribute each called path to the route file that would actually serve it.
 *
 * Next resolves a STATIC segment before a dynamic one, so `api/inbox/polish`
 * belongs to `api/inbox/polish` and must NOT also mark `api/inbox/[id]`
 * covered. Ranking by literal-segment count reproduces that, and it matters:
 * without it the gate swings from false negatives to false positives, which is
 * the worse of the two — a route reported as covered that nothing ever called.
 *
 * @param {string[]} routes  file routes, e.g. "api/public/portal/[token]/checkout"
 * @param {Iterable<string>} calledPaths  bare paths the sweep actually called
 * @returns {Set<string>} the routes genuinely exercised
 */
export function attributeCoverage(routes, calledPaths) {
  const matchers = routes.map((route) => {
    const parts = route.split("/");
    return {
      route,
      re: new RegExp(`^${parts.map((s) => (isDynamic(s) ? "[^/]+" : escapeRe(s))).join("/")}$`),
      literals: parts.filter((s) => !isDynamic(s)).length,
      depth: parts.length,
    };
  });

  const covered = new Set();
  for (const p of calledPaths) {
    const depth = p.split("/").length;
    const hits = matchers.filter((m) => m.depth === depth && m.re.test(p));
    if (hits.length === 0) continue;
    hits.sort((a, b) => b.literals - a.literals);
    covered.add(hits[0].route);
  }
  return covered;
}

/**
 * Called paths that match NO route file.
 *
 * A stray is a bug in the SWEEP, not the app: a typo'd path that quietly
 * "passed" because the server 404'd into an expected status. That is the
 * failure mode where the gate reports green while testing nothing.
 */
export function strayCalls(routes, calledPaths) {
  const out = [];
  for (const p of calledPaths) {
    if (attributeCoverage(routes, [p]).size === 0) out.push(p);
  }
  return out;
}
