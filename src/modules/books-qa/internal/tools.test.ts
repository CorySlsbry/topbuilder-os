import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS, toolsFor, toolByName } from "./tools";
import type { ResolvedScope } from "@/modules/auth-tenancy";

/**
 * ⛔ EVERY TOOL'S AUTHZ MUST BE AT LEAST AS STRICT AS THE ROUTE IT MIRRORS.
 *
 * This is the SEC-001 lesson applied per tool. The agent gate once ran on a
 * bare `requireScope()` and became a privilege-escalation path: a viewer could
 * approve a card that posted to the general ledger while the direct REST route
 * refused them 403. A comment claimed the executors ran "with the SAME authz as
 * the REST routes"; nothing enforced it.
 *
 * So this test does not read a comment or a constant. It reads the ACTUAL
 * ROUTE FILE and compares. That matters because the drift does not happen
 * today, while somebody is thinking about it — it happens in four months when
 * a route gains a department wall and the tool does not.
 */

const ROOT = process.cwd();

/** Pull the requireScope(...) argument out of a route's source. */
function routeGuards(file: string): { departments: string[]; roles: string[]; aal2: boolean } {
  const src = readFileSync(join(ROOT, file), "utf8");
  const departments = new Set<string>();
  const roles = new Set<string>();
  let aal2 = false;
  // Every requireScope call in the file — a route with a GET and a POST has
  // two, and the tool only ever performs the READ.
  for (const m of src.matchAll(/requireScope\(\s*\{([\s\S]*?)\}\s*\)/g)) {
    const body = m[1]!;
    for (const d of body.matchAll(/departments:\s*\[([^\]]*)\]/g)) {
      for (const q of d[1]!.matchAll(/["']([^"']+)["']/g)) departments.add(q[1]!);
    }
    for (const r of body.matchAll(/roles:\s*\[([^\]]*)\]/g)) {
      for (const q of r[1]!.matchAll(/["']([^"']+)["']/g)) roles.add(q[1]!);
    }
    if (/aal2:\s*true/.test(body)) aal2 = true;
  }
  return { departments: [...departments], roles: [...roles], aal2 };
}

describe("the books-qa tool registry", () => {
  it("every tool names a route file that actually exists", () => {
    // A tool with no equivalent route has no authz to copy, which is the
    // whole reason `mirrors` is required rather than documentation.
    const missing = TOOLS.filter((t) => !existsSync(join(ROOT, t.mirrors))).map(
      (t) => `${t.name} -> ${t.mirrors}`,
    );
    expect(missing).toEqual([]);
  });

  it("⛔ no tool is WEAKER than the route it mirrors", () => {
    const offenders: string[] = [];
    for (const tool of TOOLS) {
      const guards = routeGuards(tool.mirrors);
      const held = new Set(tool.requires.departments ?? []);
      // The route's READ path is the relevant one. If a route demands a
      // department anywhere in it, a tool that returns that data must too —
      // being STRICTER is always fine, being weaker never is.
      for (const dept of guards.departments) {
        if (!held.has(dept)) offenders.push(`${tool.name} is missing "${dept}" (${tool.mirrors})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the financial tools all sit behind the financials wall", () => {
    // Belt and braces on the check above: if a route ever loses its wall by
    // mistake, the comparison test would go quiet. This one states the
    // expectation directly.
    const open = TOOLS.filter((t) => !(t.requires.departments ?? []).includes("financials")).map(
      (t) => t.name,
    );
    // `job_list` is the ONE tool outside the wall, and it exists so the model
    // can resolve "the Henderson job" to an id without being handed the book
    // of business. A job name and number is not a money figure.
    expect(open).toEqual(["job_list"]);
  });

  it("no tool executes SQL, composes a query, or takes a query string", () => {
    // Not a "read-only SQL tool". Not a "SELECT-only" one. The blast radius of
    // a model that can shape a query is the entire database, and RLS is the
    // only thing between it and another tenant.
    // Comments stripped first: the registry's own doc comment says the words
    // "SELECT-only" while explaining why there is no such tool, and a test
    // that fails on its own prose is a test nobody trusts.
    const src = readFileSync(join(ROOT, "src/modules/books-qa/internal/tools.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/\bc\.query\(|\bSELECT\b|\bpool\b/);
    for (const tool of TOOLS) {
      const props = Object.keys(
        (tool.schema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect(props.filter((p) => /sql|query|where|filter/i.test(p)), tool.name).toEqual([]);
    }
  });

  it("every tool's arguments are a CLOSED schema", () => {
    // additionalProperties:false everywhere. An open schema is an invitation
    // for the model to pass something the zod parse then has to notice.
    for (const tool of TOOLS) {
      expect((tool.schema as { additionalProperties?: boolean }).additionalProperties, tool.name).toBe(
        false,
      );
    }
  });

  it("names are unique and stable-looking", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n, n).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("every tool points somewhere a person can go and check it", () => {
    // The citations strip links here. It is the trust mechanism and it costs
    // nothing: the user can always go look at the screen the figure came from.
    for (const t of TOOLS) expect(t.href, t.name).toMatch(/^\//);
  });
});

describe("⛔ the tool list is filtered by scope — layer one of two", () => {
  const crew: ResolvedScope = {
    uid: "dev:crew@example.com",
    tenantId: "t-1",
    role: "staff",
    departments: ["field"],
  };
  const owner: ResolvedScope = {
    uid: "dev:owner@example.com",
    tenantId: "t-1",
    role: "owner",
    departments: [],
  };

  it("a seat without the financials wall never LEARNS the money tools exist", () => {
    const names = toolsFor(crew).map((t) => t.name);
    expect(names).toEqual(["job_list"]);
    // Not merely "cannot call it" — cannot see it. An injected instruction
    // cannot name a tool that was never offered.
    expect(names).not.toContain("cash_plan");
  });

  it("an owner gets everything, because owner/admin hold every wall", () => {
    expect(toolsFor(owner).length).toBe(TOOLS.length);
  });

  it("filtering is UX; the dispatcher re-checks anyway", () => {
    // Stated here so the relationship is not lost: this test proves the list
    // is narrowed. `dispatch` in ask.ts proves the call is refused. Both, on
    // purpose — a filter is a convenience and a check is a control.
    expect(toolByName("cash_plan")).toBeDefined();
  });
});
