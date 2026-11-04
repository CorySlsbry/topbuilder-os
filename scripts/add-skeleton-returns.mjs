/**
 * Second half of the skeleton codemod: the early-return block itself.
 *
 * `add-skeletons.mjs` wires the hook; this inserts the render. They are
 * separate because the hook is a pure transform and this one carries a
 * DECISION per page — the title shown in the shell and which preset mirrors
 * that screen's real layout. Those are listed here so they can be reviewed as
 * a list rather than hunted across 20 diffs.
 *
 * Idempotent: a page that already renders <PageSkeleton is skipped.
 *
 *   node scripts/add-skeleton-returns.mjs [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHECK = process.argv.includes("--check");

/**
 * file → [AppShell title, preset, guard].
 * The title MUST match the page own heading. The guard is the page own
 * "no data yet" condition — most screens gained a `loaded` boolean, but the
 * ones that already had a `T | null` primary state keep using it.
 */
const PAGES = {
  "src/app/accountant/page.tsx": ["Accountant", "detail"],
  "src/app/account/page.tsx": ["Your data", "form"],
  "src/app/reports/page.tsx": ["Reports", "stats"],
  "src/app/money/page.tsx": ["Money HQ", "stats"],
  "src/app/bank/page.tsx": ["Bank", "table"],
  "src/app/crew/page.tsx": ["Crew & time", "table"],
  "src/app/customers/page.tsx": ["Customers", "list"],
  "src/app/intake/page.tsx": ["Intake", "list"],
  "src/app/inventory/page.tsx": ["Stock", "table"],
  "src/app/memberships/page.tsx": ["Memberships", "list"],
  "src/app/pricebook/page.tsx": ["Pricebook", "table"],
  "src/app/purchasing/page.tsx": ["Purchasing", "table"],
  "src/app/team/page.tsx": ["Team & access", "list"],
  "src/app/jobs/[id]/estimate/page.tsx": ["Build an estimate", "form"],
  "src/app/jobs/page.tsx": ["Jobs", "list", "!jobs"],
  "src/app/approvals/page.tsx": ["Approvals", "list", "!groups"],
  "src/app/dispatch/page.tsx": ["Dispatch", "table", "!board"],
};

const touched = [];
const skipped = [];

for (const [rel, [title, kind, guard = "!loaded"]] of Object.entries(PAGES)) {
  const path = join(process.cwd(), rel);
  let src;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    skipped.push(`${rel} — no such file`);
    continue;
  }
  if (src.includes("<PageSkeleton")) {
    skipped.push(`${rel} — already renders a skeleton`);
    continue;
  }
  if (!src.includes("useFirstLoad(")) {
    skipped.push(`${rel} — hook not wired; run add-skeletons.mjs first`);
    continue;
  }

  const lines = src.split("\n");
  // The component's own `return (` — the LAST one at two-space indent whose
  // next non-empty line opens the shell.
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "  return (" && /^\s*<AppShell/.test(lines[i + 1] ?? "")) at = i;
  }
  if (at === -1) {
    skipped.push(`${rel} — no "  return (" followed by <AppShell`);
    continue;
  }

  // `error` is the near-universal name, but a couple of screens only carry a
  // `note`. Render whichever the page actually has, or neither.
  const hasError = /const \[error, setError\] = useState/.test(src);
  const feedback = hasError
    ? [`        {error && <p className="error">{error}</p>}`]
    : [];

  lines.splice(
    at,
    0,
    `  // First paint: a wireframe of this screen, inside the shell. Never on a`,
    `  // refetch — useFirstLoad latches, so saving does not re-flash the page.`,
    `  if (${guard}) {`,
    `    return (`,
    `      <AppShell title="${title}">`,
    `        {showSkeleton && <PageSkeleton kind="${kind}" />}`,
    ...feedback,
    `      </AppShell>`,
    `    );`,
    `  }`,
    ``,
  );

  if (!CHECK) writeFileSync(path, lines.join("\n"), "utf8");
  touched.push(`${rel}  (${kind})`);
}

console.log(`${CHECK ? "would touch" : "touched"}: ${touched.length}`);
for (const t of touched) console.log(`  + ${t}`);
if (skipped.length) {
  console.log(`skipped: ${skipped.length}`);
  for (const s of skipped) console.log(`  - ${s}`);
}
