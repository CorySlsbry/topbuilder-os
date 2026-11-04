"use client";
import Link from "next/link";
import { useMemo } from "react";

/**
 * Pick a cost code, grouped by division.
 *
 * ── WHAT THIS REPLACES ───────────────────────────────────────────────────
 * A free-text box on the job screen, and a hardcoded `4100` on the field
 * screen, in purchasing, and on the bank screen. Every job cost in the
 * business landed on one code, which made the by-code breakdown on the job
 * money screen a single row that said nothing, and left the
 * estimate-vs-actual loop with no dimension to compare on.
 *
 * ── AN EMPTY LIST SAYS SO ────────────────────────────────────────────────
 * When a shop has no cost codes this renders a link to set them up rather
 * than an empty dropdown or — worse — a plausible wrong list. The first
 * version of the bank picker fell back to the chart of accounts so it would
 * never be empty; opening it in a browser showed an HVAC shop a list led by
 * "Accumulated allocations, land and land development costs". A wrong
 * vocabulary gets used. An empty one gets fixed.
 */

export interface CostCodeOption {
  code: string;
  name: string;
  kind: string;
  division?: string | null;
}

export default function CostCodeSelect({
  costCodes,
  value,
  onChange,
  id,
  label = "Cost code",
  /** Called with the code's own kind when one is picked, so the caller can
   *  keep a labor/material/sub selector in step without the user doing it. */
  onKind,
}: {
  costCodes: CostCodeOption[];
  value: string;
  onChange: (code: string) => void;
  id?: string;
  label?: string;
  onKind?: (kind: string) => void;
}) {
  const groups = useMemo(() => {
    const by = new Map<string, CostCodeOption[]>();
    for (const c of costCodes) {
      const key = c.division?.trim() || "Other";
      const list = by.get(key);
      if (list) list.push(c);
      else by.set(key, [c]);
    }
    return [...by.entries()];
  }, [costCodes]);

  if (costCodes.length === 0) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        No cost codes yet.{" "}
        <Link href="/cost-codes">Set them up</Link> — they&apos;re what make
        the job-cost report, WIP and your bonding schedule mean anything.
      </p>
    );
  }

  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        const found = costCodes.find((c) => c.code === e.target.value);
        if (found && onKind) onKind(found.kind);
      }}
    >
      <option value="">Choose a cost code…</option>
      {groups.map(([division, items]) => (
        <optgroup key={division} label={division}>
          {items.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} · {c.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
