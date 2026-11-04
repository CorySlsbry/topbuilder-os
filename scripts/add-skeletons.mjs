/**
 * One-shot codemod: wire the first-load skeleton into the client screens.
 *
 * The migration is mechanically identical on every page — two imports and one
 * `const showSkeleton = useFirstLoad(<ready>)` — and doing it by hand across
 * ~28 files is how a typo gets into three of them. This applies it once,
 * reports exactly what it touched, and is idempotent so a re-run is a no-op.
 *
 * It deliberately does NOT invent the early-return block. That part differs
 * per page (the title, the skeleton kind, whether the page also has a real bug
 * to fix) and is a decision, not a transform.
 *
 *   node scripts/add-skeletons.mjs          # apply
 *   node scripts/add-skeletons.mjs --check  # report only
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHECK = process.argv.includes("--check");

/** file → the expression that means "the first load has finished". */
const PAGES = {
  "src/app/wip/page.tsx": "r !== null",
  "src/app/agents/page.tsx": "data !== null",
  "src/app/billing/page.tsx": "sub !== null",
  "src/app/jobs/[id]/page.tsx": "s !== null",
  "src/app/jobs/[id]/money/page.tsx": "c !== null",
  "src/app/approvals/page.tsx": "groups !== null",
  "src/app/jobs/page.tsx": "jobs !== null",
  "src/app/purchasing/[id]/page.tsx": "bill !== null",
  "src/app/accountant/page.tsx": "loaded",
  "src/app/account/page.tsx": "loaded",
  "src/app/reports/page.tsx": "loaded",
  "src/app/money/page.tsx": "loaded",
  "src/app/dispatch/page.tsx": "board !== null",
  "src/app/bank/page.tsx": "loaded",
  "src/app/crew/page.tsx": "loaded",
  "src/app/customers/page.tsx": "loaded",
  "src/app/intake/page.tsx": "loaded",
  "src/app/inventory/page.tsx": "loaded",
  "src/app/memberships/page.tsx": "loaded",
  "src/app/pricebook/page.tsx": "loaded",
  "src/app/purchasing/page.tsx": "loaded",
  "src/app/team/page.tsx": "loaded",
  "src/app/jobs/[id]/estimate/page.tsx": "loaded",
  "src/app/inbox/page.tsx": "threads !== null",
};

const IMPORTS = [
  'import PageSkeleton from "@/components/Skeleton";',
  'import { useFirstLoad } from "@/lib/client/useFirstLoad";',
];

const touched = [];
const skipped = [];

for (const [rel, ready] of Object.entries(PAGES)) {
  const path = join(process.cwd(), rel);
  let src;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    skipped.push(`${rel} — no such file`);
    continue;
  }
  if (src.includes("useFirstLoad(")) {
    skipped.push(`${rel} — already wired`);
    continue;
  }

  const lines = src.split("\n");

  // ---- Shape B: the page has no `T | null` state to key off ---------------
  // 17 screens start their state as `[]` and let content silently pop in. They
  // get one boolean rather than being converted to nullable — nullability
  // would force a `?? []` at every read site, 6 to 20 per page, for no gain.
  if (ready === "loaded") {
    // The flag itself, next to the state it summarises.
    let firstState = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s+const \[[^\]]+\] = useState[(<]/.test(lines[i])) {
        firstState = i;
        break;
      }
    }
    if (firstState === -1) {
      skipped.push(`${rel} — Shape B but no useState found`);
      continue;
    }
    const ind = lines[firstState].match(/^\s*/)[0];
    lines.splice(
      firstState,
      0,
      `${ind}// Has the first load finished? The list state starts as [] and`,
      `${ind}// cannot answer that on its own.`,
      `${ind}const [loaded, setLoaded] = useState(false);`,
    );

    // …and set it at the end of the loader's happy path.
    const start = lines.findIndex((l) => /const load\w* = useCallback\(async \(\) => \{/.test(l));
    if (start === -1) {
      skipped.push(`${rel} — Shape B but no load useCallback found`);
      continue;
    }
    const loaderIndent = lines[start].match(/^\s*/)[0];
    let closed = -1;
    for (let i = start + 1; i < lines.length; i++) {
      if (new RegExp(`^${loaderIndent}\\s{2}\\} catch`).test(lines[i])) {
        closed = i;
        break;
      }
    }
    if (closed === -1) {
      skipped.push(`${rel} — Shape B but no catch block to anchor setLoaded`);
      continue;
    }
    lines.splice(closed, 0, `${loaderIndent}      setLoaded(true);`);
  }

  // ---- imports: after the last top-level import line ----------------------
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import .*;$/.test(lines[i])) lastImport = i;
    if (/^(interface|export|const|function|type) /.test(lines[i])) break;
  }
  if (lastImport === -1) {
    skipped.push(`${rel} — could not find the import block`);
    continue;
  }
  lines.splice(lastImport + 1, 0, ...IMPORTS);

  // ---- the hook: immediately after the LAST useState in the component -----
  // Placing it after the state it reads keeps the diff readable and means the
  // expression is always in scope.
  let lastState = -1;
  for (let i = lastImport + 1; i < lines.length; i++) {
    if (/^\s+const \[[^\]]+\] = (useState|useRef)[(<]/.test(lines[i])) lastState = i;
  }
  if (lastState === -1) {
    skipped.push(`${rel} — could not find a useState to anchor to`);
    continue;
  }
  const indent = lines[lastState].match(/^\s*/)[0];
  lines.splice(
    lastState + 1,
    0,
    `${indent}// First load only: the latch inside useFirstLoad means act()'s`,
    `${indent}// refetch after every save never re-arms this.`,
    `${indent}const showSkeleton = useFirstLoad(${ready});`,
  );

  if (!CHECK) writeFileSync(path, lines.join("\n"), "utf8");
  touched.push(rel);
}

console.log(`${CHECK ? "would touch" : "touched"}: ${touched.length}`);
for (const t of touched) console.log(`  + ${t}`);
if (skipped.length) {
  console.log(`skipped: ${skipped.length}`);
  for (const s of skipped) console.log(`  - ${s}`);
}
