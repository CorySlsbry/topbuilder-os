// Statement parsing — pure, deterministic, no I/O.
// v1 formats: CSV (header-mapped) and OFX/QFX (STMTTRN blocks). PDF parsing
// arrives with the bankstatementparser worker later. A parser NEVER guesses
// an amount: anything unparseable is reported as a skipped row, not a zero.
import { createHash } from "node:crypto";
import { parseCsvRecords } from "@/lib/csv";

export interface StatementTxn {
  postedOn: string; // yyyy-mm-dd
  amountCents: number; // SIGNED: negative = money out
  description: string;
}

export interface ParseResult {
  txns: StatementTxn[];
  skipped: number; // rows we could not confidently parse (reported, never silent)
}

/** Lowercase, collapse whitespace — the stable basis for matching + dedupe. */
export function normalizeDescription(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Dedupe key: same account + date + amount + normalized memo = same txn. */
export function fingerprint(
  accountId: string,
  txn: StatementTxn,
): string {
  return createHash("sha256")
    .update(`${accountId}|${txn.postedOn}|${txn.amountCents}|${normalizeDescription(txn.description)}`)
    .digest("hex");
}

/**
 * A rule matcher token from a bank description: store numbers, phone numbers,
 * and punctuation-only fragments stripped — "HOME DEPOT #1234" and
 * "HOME DEPOT #99" learn the SAME rule.
 */
export function ruleMatcherFrom(description: string): string {
  return normalizeDescription(description)
    .replace(/[0-9#*]+/g, " ")
    .split(/\s+/)
    .filter((token) => /[a-z]/.test(token)) // drop "-", "--", etc.
    .join(" ")
    .slice(0, 32)
    .trim();
}

const DATE_KEYS = ["date", "posted", "transaction date", "post date", "posting date"];
const DESC_KEYS = ["description", "memo", "payee", "name", "details", "transaction"];
const AMOUNT_KEYS = ["amount", "amt"];
const DEBIT_KEYS = ["debit", "withdrawal", "withdrawals", "money out"];
const CREDIT_KEYS = ["credit", "deposit", "deposits", "money in"];

function findKey(headers: string[], candidates: string[]): string | undefined {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const cand of candidates) {
    const i = lower.findIndex((h) => h === cand || h.includes(cand));
    if (i >= 0) return headers[i];
  }
  return undefined;
}

function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // M/D/YYYY (US bank exports)
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  m = /^(\d{8})$/.exec(s); // YYYYMMDD (OFX)
  if (m) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return null;
}

function parseSignedCents(raw: string): number | null {
  let s = raw.trim().replace(/[$,]/g, "");
  if (s === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true; // (123.45) accounting style
    s = s.slice(1, -1);
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number(frac.slice(0, 2).padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** CSV: header-mapped. Supports one signed Amount column OR debit+credit pair. */
export function parseCsvStatement(content: string): ParseResult {
  const records = parseCsvRecords(content);
  if (records.length === 0) return { txns: [], skipped: 0 };
  const headers = Object.keys(records[0]!);
  const dateKey = findKey(headers, DATE_KEYS);
  const descKey = findKey(headers, DESC_KEYS);
  const amountKey = findKey(headers, AMOUNT_KEYS);
  const debitKey = findKey(headers, DEBIT_KEYS);
  const creditKey = findKey(headers, CREDIT_KEYS);
  if (!dateKey || !descKey || (!amountKey && !debitKey && !creditKey)) {
    // Unrecognizable layout — report everything skipped, parse nothing.
    return { txns: [], skipped: records.length };
  }

  const txns: StatementTxn[] = [];
  let skipped = 0;
  for (const r of records) {
    const postedOn = parseDate(r[dateKey] ?? "");
    const description = (r[descKey] ?? "").trim();
    let amountCents: number | null = null;
    if (amountKey) {
      amountCents = parseSignedCents(r[amountKey] ?? "");
    } else {
      const debit = debitKey ? parseSignedCents(r[debitKey] ?? "") : null;
      const credit = creditKey ? parseSignedCents(r[creditKey] ?? "") : null;
      if (debit !== null && debit !== 0) amountCents = -Math.abs(debit);
      else if (credit !== null && credit !== 0) amountCents = Math.abs(credit);
    }
    if (!postedOn || !description || amountCents === null || amountCents === 0) {
      skipped += 1;
      continue;
    }
    txns.push({ postedOn, amountCents, description });
  }
  return { txns, skipped };
}

/** OFX/QFX: extract STMTTRN blocks (SGML or XML flavored). */
export function parseOfx(content: string): ParseResult {
  const blocks = content.match(/<STMTTRN>[\s\S]*?(<\/STMTTRN>|(?=<STMTTRN>)|$)/gi) ?? [];
  const txns: StatementTxn[] = [];
  let skipped = 0;
  for (const block of blocks) {
    const tag = (name: string): string | null => {
      const m = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block);
      return m ? m[1]!.trim() : null;
    };
    const postedOn = parseDate((tag("DTPOSTED") ?? "").slice(0, 8));
    const amountCents = parseSignedCents(tag("TRNAMT") ?? "");
    const description = tag("NAME") ?? tag("MEMO") ?? "";
    if (!postedOn || amountCents === null || amountCents === 0 || !description) {
      skipped += 1;
      continue;
    }
    txns.push({ postedOn, amountCents, description });
  }
  return { txns, skipped };
}

export function detectFormat(filename: string, content: string): "csv" | "ofx" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".ofx") || lower.endsWith(".qfx")) return "ofx";
  if (lower.endsWith(".csv")) return "csv";
  if (/<OFX>/i.test(content) || /<STMTTRN>/i.test(content)) return "ofx";
  if (content.includes(",")) return "csv";
  return null;
}
