"use client";
import { useMemo } from "react";

/**
 * Pick a category by NAME.
 *
 * The bank screen used to ask for a raw account code in a text box — "6210" —
 * which only works if you have already memorised a 478-row chart of accounts.
 * Everybody coming off QuickBooks expects to pick "Fuel and auto" from a list.
 *
 * ── WHY A PLAIN <select> ─────────────────────────────────────────────────
 * It is keyboard-operable for free, type-to-jump works, iOS and Android give
 * it a native full-screen wheel that beats anything hand-rolled on a phone,
 * screen readers already know what it is, and it needs no CSS and no
 * dependency. A custom combobox here would be a worse control with more code.
 *
 * ── THE TWO GROUPS ───────────────────────────────────────────────────────
 * "Your usual categories" is the accounts this shop has actually posted to in
 * the last year, most-used first. That is a COUNT(*), not a guess — the one
 * thing this control is smart about is the one thing it cannot be wrong
 * about. Everything else follows, grouped by the chart's own sections, so a
 * category that has never been used is still one scroll away rather than
 * hidden.
 */

export interface CategoryOption {
  code: string;
  name: string;
  type: string;
  section: string | null;
  uses: number;
}

/** Money out ranks costs first; money in ranks income first. Ranking only —
 *  nothing is ever removed, because a supplier refund is money IN that
 *  belongs against the expense it came from, and hiding that account is how
 *  a line ends up coded to "Ask my accountant". */
const OUT_FIRST = ["cogs", "expense", "asset", "liability", "equity", "revenue", "other"];
const IN_FIRST = ["revenue", "other", "asset", "liability", "equity", "cogs", "expense"];

/**
 * The whole of the control's behaviour, as a pure function, so the ordering
 * can be tested without rendering anything. What ends up at the top of this
 * list is what most lines get coded to — it is worth asserting rather than
 * eyeballing.
 */
export function groupCategories(
  categories: CategoryOption[],
  direction: "in" | "out",
): { usual: CategoryOption[]; sections: [string, CategoryOption[]][] } {
  const order = direction === "out" ? OUT_FIRST : IN_FIRST;
  const rank = (t: string) => {
    const i = order.indexOf(t);
    return i === -1 ? order.length : i;
  };

  const usual = categories
    .filter((c) => c.uses > 0)
    .sort((a, b) => rank(a.type) - rank(b.type) || b.uses - a.uses)
    .slice(0, 12);

  // Grouped by the chart's own section labels, in the ranked type order, so
  // an HVAC shop coding a fuel charge meets its cost sections before equity.
  const bySection = new Map<string, CategoryOption[]>();
  for (const c of [...categories].sort(
    (a, b) => rank(a.type) - rank(b.type) || a.code.localeCompare(b.code),
  )) {
    const key = c.section?.trim() || "Other accounts";
    const list = bySection.get(key);
    if (list) list.push(c);
    else bySection.set(key, [c]);
  }
  return { usual, sections: [...bySection.entries()] };
}

export default function CategoryPicker({
  categories,
  value,
  onChange,
  direction,
  id,
  label = "Category",
}: {
  categories: CategoryOption[];
  value: string;
  onChange: (code: string) => void;
  /** "out" = money left the account; ranks cost accounts first. */
  direction: "in" | "out";
  id?: string;
  label?: string;
}) {
  const { usual, sections } = useMemo(
    () => groupCategories(categories, direction),
    [categories, direction],
  );

  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ minWidth: 0 }}
    >
      <option value="">Choose a category…</option>
      {usual.length > 0 && (
        <optgroup label="Your usual categories">
          {usual.map((c) => (
            <option key={`u-${c.code}`} value={c.code}>
              {c.name} ({c.code})
            </option>
          ))}
        </optgroup>
      )}
      {sections.map(([section, items]) => (
        <optgroup key={section} label={section}>
          {items.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name} ({c.code})
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
