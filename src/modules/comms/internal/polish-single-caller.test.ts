import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * EXACTLY ONE route may call polish().
 *
 * This is a structural test, not a style rule, and the thing it protects is a
 * contract rather than a function: **the helper never replaces what you typed
 * — it shows both and you pick.**
 *
 * That contract lives in the UI, not in `polish()`. So the moment a second
 * route exists, a second box exists, and the shapes drift: one of them
 * eventually swaps the text in place, because auto-replace is genuinely
 * simpler to write. And the copy that does it will be the one attached to a
 * price, because that is the surface somebody was in a hurry on.
 *
 * The cheapest way to keep four call sites honest is to make a fifth route
 * fail the build.
 */

const API_DIR = join(process.cwd(), "src", "app", "api");
const COMPONENTS_DIR = join(process.cwd(), "src", "components");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("the polish helper has exactly one caller", () => {
  const routeFiles = walk(API_DIR);

  it("exactly one route file calls polish(", () => {
    const callers = routeFiles.filter((f) => /\bpolish\s*\(/.test(readFileSync(f, "utf8")));
    const rel = callers.map((f) => f.slice(process.cwd().length + 1).replace(/\\/g, "/"));
    expect(rel).toEqual(["src/app/api/assist/polish/route.ts"]);
  });

  it("and it lives under /api/assist, not under any one feature", () => {
    // A path that names one caller invites a second copy for the next one.
    const rel = routeFiles.map((f) => f.slice(process.cwd().length + 1).replace(/\\/g, "/"));
    expect(rel).toContain("src/app/api/assist/polish/route.ts");
    expect(rel).not.toContain("src/app/api/inbox/polish/route.ts");
  });

  it("every screen goes through the one shared component", () => {
    // The component is where the contract actually lives — original and
    // rewrite side by side, and a human picks. Screens must not hand-roll it.
    const pages = walk(join(process.cwd(), "src", "app")).filter(
      (f) => f.endsWith(".tsx") && !f.includes(`${"api"}${"/"}`) && !f.includes("\\api\\"),
    );
    const hardRolled = pages.filter((f) => {
      const src = readFileSync(f, "utf8");
      return src.includes("/api/assist/polish") && !f.endsWith("PolishBox.tsx");
    });
    const rel = hardRolled.map((f) => f.slice(process.cwd().length + 1).replace(/\\/g, "/"));
    expect(rel, "these screens call the polish endpoint directly instead of using <PolishBox>").toEqual(
      [],
    );
  });

  it("the shared component exists where the screens expect it", () => {
    const components = walk(COMPONENTS_DIR).map((f) =>
      f.slice(process.cwd().length + 1).replace(/\\/g, "/"),
    );
    expect(components).toContain("src/components/PolishBox.tsx");
  });
});
