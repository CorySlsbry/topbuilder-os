import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { Capability } from "./plans";

/**
 * ⛔ EVERY ROUTE BEHIND THE LIGHT FENCE MUST SAY SO, IN ITS OWN FILE.
 *
 * Hiding a nav item is UX. The wall is the route, and a wall with one gate
 * left open is not a wall — a $99 tenant who knows the URL walks straight
 * into the crew tools. Declaring the capability per route matches how the
 * department walls already work, and this test is what makes "we fenced them
 * all" checkable instead of remembered.
 *
 * It is deliberately structural, in the mould of the polish-single-caller
 * test: it reads the route SOURCE. Add a new file under a fenced prefix and
 * forget the guard, and the build fails naming your file.
 */

const API_DIR = join(process.cwd(), "src", "app", "api");

/** Path prefix under src/app/api → the capability it requires. */
const FENCE: [string, Capability][] = [
  ["dispatch", "dispatch"],
  ["workforce", "workforce"],
  ["pos", "purchasing"],
  ["inventory", "inventory"],
  ["bonding", "bonding"],
  ["wip", "bonding"],
  ["agents", "agents"],
  ["approvals", "agents"],
  ["comms", "comms"],
  ["inbox", "comms"],
];

/**
 * Routes under a fenced prefix that are deliberately NOT fenced, each with a
 * reason. An exemption is a claim that the route is safe for a Light tenant —
 * not a way to make this test quiet.
 */
const EXEMPT = new Map<string, string>([
  // The cron is a machine principal running for EVERY tenant; it is not a
  // tenant-facing surface and the agents it runs are already policy-gated.
  ["agents/policies", "reads/writes the on-off switches; a Light tenant sees an empty list, and setMode on a fenced agent is inert"],
]);

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

describe("the Light fence is enforced on the server, route by route", () => {
  const files = routeFiles(API_DIR).map((f) => ({
    path: relative(API_DIR, f).split(sep).slice(0, -1).join("/"),
    src: readFileSync(f, "utf8"),
  }));

  it("finds the API tree at all (a zero-file pass would be meaningless)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const [prefix, capability] of FENCE) {
    it(`every /api/${prefix} route asserts "${capability}"`, () => {
      const under = files.filter((f) => f.path === prefix || f.path.startsWith(`${prefix}/`));
      expect(under.length, `no routes found under ${prefix} — did the tree move?`)
        .toBeGreaterThan(0);

      const missing = under
        .filter((f) => !EXEMPT.has(f.path))
        .filter((f) => !f.src.includes(`assertCapability(scope, "${capability}")`))
        .map((f) => `api/${f.path}`);

      expect(missing, `unfenced routes under ${prefix}`).toEqual([]);
    });
  }

  it("ask-your-books is fenced (the only multi-turn model loop we run)", () => {
    const books = files.find((f) => f.path === "assist/books");
    expect(books, "api/assist/books not found").toBeTruthy();
    expect(books!.src).toContain('assertCapability(scope, "booksQa")');
  });

  it("⛔ the money loop is NOT fenced anywhere", () => {
    // The doctrine's actual promise. If somebody ever puts a capability check
    // on invoicing or the books, this fails and they have to argue for it.
    const core = ["invoices", "estimates", "jobs", "customers", "bank", "reports", "ledger"];
    const fenced = files
      .filter((f) => core.some((c) => f.path === c || f.path.startsWith(`${c}/`)))
      .filter((f) => f.src.includes("assertCapability("))
      .map((f) => `api/${f.path}`);
    expect(fenced, "a money-loop route grew a capability fence").toEqual([]);
  });

  it("every exemption still points at a real route", () => {
    for (const path of EXEMPT.keys()) {
      expect(files.some((f) => f.path === path), `stale exemption: ${path}`).toBe(true);
    }
  });
});
