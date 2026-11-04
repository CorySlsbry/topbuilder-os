import { describe, expect, it } from "vitest";
// A plain .mjs helper, shared with the endpoint-sweep script so the script and
// this test can never drift apart. TS resolves it through allowJs.
import { attributeCoverage, bare, strayCalls } from "../scripts/lib/coverage.mjs";

/**
 * The endpoint sweep's coverage gate is one of the two structural guards this
 * codebase leans on hardest ("adding a route and not covering it BREAKS the
 * sweep"). It was quietly unable to see any dynamic segment not named `[id]`.
 *
 * A gate you trust and that cannot fire is worse than no gate, so the matcher
 * gets a test of its own rather than being verified by watching output.
 */

const ROUTES = [
  "api/public/intake/[slug]",
  "api/public/book/[slug]",
  "api/public/portal/[token]",
  "api/public/portal/[token]/checkout",
  "api/inbox",
  "api/inbox/[id]",
  "api/inbox/[id]/messages",
  "api/inbox/polish",
  "api/inbox/media/[id]",
  "api/reports/1099",
  "api/jobs/[id]/costing",
];

describe("bare", () => {
  it("strips the leading slash and the query string", () => {
    expect(bare("/api/jobs/abc?status=open")).toBe("api/jobs/abc");
    expect(bare("api/inbox")).toBe("api/inbox");
  });
});

describe("attributeCoverage — the routes the old matcher could never see", () => {
  it("covers a [slug] route", () => {
    expect([...attributeCoverage(ROUTES, ["api/public/book/desert-aire"])]).toEqual([
      "api/public/book/[slug]",
    ]);
  });

  it("covers a [token] route, and its nested child", () => {
    expect([...attributeCoverage(ROUTES, ["api/public/portal/9f8e-aaaa"])]).toEqual([
      "api/public/portal/[token]",
    ]);
    expect([...attributeCoverage(ROUTES, ["api/public/portal/9f8e/checkout"])]).toEqual([
      "api/public/portal/[token]/checkout",
    ]);
  });
});

describe("attributeCoverage — static wins over dynamic, like Next itself", () => {
  it("/api/inbox/polish is the static route, not [id]", () => {
    const c = attributeCoverage(ROUTES, ["api/inbox/polish"]);
    expect([...c]).toEqual(["api/inbox/polish"]);
    // The failure that would be WORSE than the bug being fixed: a route
    // reported covered that nothing ever called.
    expect(c.has("api/inbox/[id]")).toBe(false);
  });

  it("a bare number is still a route NAME, not a param", () => {
    // The old matcher had a hand-written carve-out for exactly this case.
    // Structural matching gets it right without one.
    expect([...attributeCoverage(ROUTES, ["api/reports/1099"])]).toEqual(["api/reports/1099"]);
  });

  it("a uuid in the same position IS the dynamic route", () => {
    expect([...attributeCoverage(ROUTES, ["api/inbox/7c9e6679-7425-40de-944b-e07fc1f90ae7"])]).toEqual(
      ["api/inbox/[id]"],
    );
  });

  it("depth is respected — a shorter path never matches a longer route", () => {
    expect([...attributeCoverage(ROUTES, ["api/inbox"])]).toEqual(["api/inbox"]);
  });

  it("nested dynamic segments resolve", () => {
    expect([...attributeCoverage(ROUTES, ["api/inbox/abc-123/messages"])]).toEqual([
      "api/inbox/[id]/messages",
    ]);
    expect([...attributeCoverage(ROUTES, ["api/inbox/media/xyz"])]).toEqual([
      "api/inbox/media/[id]",
    ]);
  });
});

describe("strayCalls", () => {
  it("flags a called path that matches no route file", () => {
    // The failure mode this catches: a typo'd path in the sweep that "passes"
    // because the server 404s into an expected status, so the gate reports
    // green while testing nothing.
    expect(strayCalls(ROUTES, ["api/inbxo/polish"])).toEqual(["api/inbxo/polish"]);
  });

  it("says nothing about legitimate calls", () => {
    expect(strayCalls(ROUTES, ["api/inbox/polish", "api/public/book/x"])).toEqual([]);
  });
});
