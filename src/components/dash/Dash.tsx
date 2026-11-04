"use client";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The dashboard kit.
 *
 * Modelled on the Salisbury CFO contractor dashboards, whose format is the
 * point: a numbered list of DECISIONS at the top, then tiles, then sections
 * that each carry their own mini-tiles, chart and table, with a plain-English
 * caveat under anything that could be misread.
 *
 * ── WHAT MAKES THAT FORMAT WORK ──────────────────────────────────────────
 * 1. The first thing on the page is not a number, it is a SENTENCE with a
 *    name and a dollar figure in it. "Invoice $147,942 already earned on
 *    Canyon Rim — never billed" is a decision. A tile reading $147,942 is
 *    a fact somebody still has to interpret.
 * 2. Every tile has a sub-line giving the number context. "$588,000" means
 *    nothing; "$588,000 · $175,900 late (29.9%)" means something.
 * 3. Status is LABELLED, never colour alone — "42d late", not a red cell.
 *    Roughly one man in twelve cannot reliably tell the red one from the
 *    green one, and every contractor reads this in a truck in sunlight.
 */

// ───────────────────────────────────────────────── the decision list

export interface Decision {
  /** The whole decision, as one sentence, with the figures already in it. */
  text: string;
  /** Where to go and do something about it. */
  href?: string;
  /** true = money is leaking now, not merely worth knowing. */
  urgent?: boolean;
}

export function DecisionList({
  title,
  decisions,
  emptyText,
  urgentLabel = "costing money now",
}: {
  title: string;
  decisions: Decision[];
  emptyText: string;
  /**
   * What the urgency pill says. Defaults to the owner's meaning, because that
   * is what this list was built for — but the FIELD board reuses this component
   * and nothing on it is about money. Telling a tech that an unanswered service
   * call is "costing money now" is both wrong and the exact ledger-flavoured
   * framing the `field` wall exists to keep off that screen.
   */
  urgentLabel?: string;
}) {
  return (
    <div className="card">
      <div className="navgroup" style={{ padding: 0, marginBottom: 8 }}>{title}</div>
      {decisions.length === 0 ? (
        <p style={{ margin: 0 }}>{emptyText}</p>
      ) : (
        <ol style={{ margin: 0, paddingLeft: "1.35rem" }}>
          {decisions.map((d, i) => (
            <li key={i} style={{ marginBottom: 6 }}>
              {d.href ? <Link href={d.href}>{d.text}</Link> : d.text}
              {d.urgent && (
                <>
                  {" "}
                  <span className="pill" style={{ background: "var(--warn-bg)" }}>
                    {urgentLabel}
                  </span>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────── KPI tiles

export interface Kpi {
  label: string;
  value: string;
  /** The context line. A number without one is a number nobody can act on. */
  sub?: string;
  href?: string;
  /** Draws attention without relying on colour alone — the sub-line says why. */
  attention?: boolean;
}

export function KpiRow({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="card">
      <div className="row" style={{ flexWrap: "wrap", rowGap: 14 }}>
        {kpis.map((k) => {
          const body = (
            <>
              <div className="muted">{k.label}</div>
              <div className="big">{k.value}</div>
              {k.sub && (
                <div className="muted" style={{ fontSize: "0.78rem" }}>
                  {k.sub}
                </div>
              )}
            </>
          );
          return (
            <div
              key={k.label}
              className="grow"
              style={{
                minWidth: 150,
                // The border is the attention signal, and the sub-line always
                // SAYS what is wrong — colour is never the only channel.
                borderLeft: k.attention ? "3px solid var(--danger)" : undefined,
                paddingLeft: k.attention ? 10 : undefined,
              }}
            >
              {k.href ? (
                <Link href={k.href} style={{ textDecoration: "none", color: "inherit" }}>
                  {body}
                </Link>
              ) : (
                body
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────── a section

export function Section({
  title,
  subtitle,
  caveat,
  children,
}: {
  title: string;
  /** The section's headline figures, as one line of prose. */
  subtitle?: string;
  /** The sentence that stops the section being misread. Not optional in
   *  spirit — every money section has one thing people get wrong about it. */
  caveat?: string;
  children: ReactNode;
}) {
  return (
    <>
      <div className="row" style={{ marginTop: 18, alignItems: "baseline" }}>
        <h2 className="grow" style={{ margin: 0 }}>{title}</h2>
        {subtitle && <span className="muted">{subtitle}</span>}
      </div>
      {children}
      {caveat && (
        <p className="muted" style={{ marginTop: 6 }}>
          {caveat}
        </p>
      )}
    </>
  );
}

/**
 * A table that scrolls inside itself rather than pushing the page sideways,
 * and that says how it is sorted — because "why is this row first?" is the
 * first question anybody asks of a list they did not build.
 */
export function DataTable({
  headers,
  rows,
  sortedBy,
  empty = "Nothing here yet.",
  numericFrom,
}: {
  headers: string[];
  rows: (ReactNode[])[];
  sortedBy?: string;
  empty?: string;
  /** Column index from which values are numbers and should right-align. */
  numericFrom?: number;
}) {
  if (rows.length === 0) {
    return (
      <div className="card">
        <p style={{ margin: 0 }}>{empty}</p>
      </div>
    );
  }
  return (
    <>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th
                  key={h}
                  style={
                    numericFrom !== undefined && i >= numericFrom
                      ? { textAlign: "right" }
                      : undefined
                  }
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((cell, j) => (
                  <td
                    key={j}
                    style={
                      numericFrom !== undefined && j >= numericFrom
                        ? { textAlign: "right" }
                        : undefined
                    }
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sortedBy && (
        <p className="muted" style={{ marginTop: 4 }}>
          {sortedBy} Status is written out, not colour-coded — this gets read
          in a truck in the sun.
        </p>
      )}
    </>
  );
}

/**
 * The label a status gets instead of a colour. "42d late" beats a red cell
 * for the same reason a road sign has words on it.
 */
export function StatusPill({ text, tone }: { text: string; tone?: "bad" | "warn" | "good" }) {
  return (
    <span
      className="pill"
      style={{
        background:
          tone === "bad"
            ? "var(--danger-tint)"
            : tone === "warn"
              ? "var(--warn-bg)"
              : tone === "good"
                ? "var(--go-tint)"
                : undefined,
      }}
    >
      {text}
    </span>
  );
}

/** Days between two ISO dates, positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );
}
