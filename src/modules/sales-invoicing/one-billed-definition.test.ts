import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ⛔ ONE DEFINITION OF "WHAT WE BILLED", AND IT IS NOT `subtotal_cents`.
 *
 * The member discount split that column in two. `subtotal_cents` became the
 * GROSS list price — correct for the invoice document, and correct against
 * the general ledger, where revenue is credited gross and the concession is
 * contra-revenue in 3490. But nine queries were already reading it to mean
 * "the pre-tax amount we actually billed", and every one of them silently
 * became an overstatement the size of the discount:
 *
 *   - true job profit and the CIP schedule (and from there postWipAdjustment,
 *     which JOURNALIZES the figure)
 *   - remaining contract in the 13-week cash plan
 *   - revenue MTD, revenue 90d, average invoice, DSO
 *   - customer lifetime totals in two modules
 *   - the credit-memo basis
 *   - THE OVERPAYMENT GUARD, which would have accepted $10,700 against a
 *     $9,200 invoice
 *
 * Migration 0058 made `net_subtotal_cents` a GENERATED column so the right
 * answer cannot drift from the two inputs. This test is the other half: it
 * stops a NEW query from reaching for the old column out of habit, which is
 * exactly how the bug got in — `subtotal_cents` had meant one thing since
 * migration 0005, and nothing announced that it had stopped.
 *
 * Scoped to `sales-invoicing` on purpose. Inside this module the gross figure
 * is legitimately the subject: it is what the invoice document prints and
 * what the posting rule credits. Everywhere else, wanting it is a mistake.
 */

const MODULES = join(process.cwd(), "src", "modules");

/** Every .ts under src/modules, minus tests and the sales-invoicing module. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** Strip comments — a comment ABOUT the column is not a read OF it. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("billed-to-date reads the net, not the list price", () => {
  const files = sourceFiles(MODULES).filter(
    (f) => !f.includes(join("modules", "sales-invoicing")),
  );

  it("finds files to check (guards a vacuous pass)", () => {
    // ⛔ The failure mode of every structural test: a path typo makes the
    // list empty and an empty list passes every assertion below it.
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.includes("bonding.ts"))).toBe(true);
    expect(files.some((f) => f.includes("costing.ts"))).toBe(true);
  });

  it("⛔ no module outside sales-invoicing reads `subtotal_cents` raw", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = code(f);
      // `net_subtotal_cents` contains the substring, so require a boundary
      // that a `net_` prefix cannot satisfy.
      if (/(?<!net_)\bsubtotal_cents\b/.test(src)) {
        offenders.push(f.slice(MODULES.length + 1).replace(/\\/g, "/"));
      }
    }
    expect(
      offenders,
      "`subtotal_cents` is the GROSS list price; the amount actually billed is `net_subtotal_cents` (migration 0058). Reading the gross overstates billings, revenue, job profit and the WIP adjustment by the size of every member discount given",
    ).toEqual([]);
  });

  it("the overpayment guard is computed on the net", () => {
    // The sharpest instance, so it gets asserted by name rather than only by
    // the sweep above (which deliberately does not cover this module).
    const store = code(
      join(MODULES, "sales-invoicing", "internal", "store.ts"),
    );
    expect(store, "recordPayment must exist to be guarded").toContain("payment_exceeds_invoice_total");
    expect(
      store,
      "the invoice total a payment is checked against must be net_subtotal + tax; using the gross subtotal accepts an overpayment the size of the discount",
    ).toMatch(/net_subtotal_cents\)\s*\+\s*Number\(invoice\.tax_cents\)/);
  });
});
