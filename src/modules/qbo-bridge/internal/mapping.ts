// Migration-in mapping — pure functions from QBO API shapes to our NAHB
// ledger. Unmapped accounts are REPORTED, never silently dropped: the
// to-the-penny guarantee depends on every balance landing somewhere visible.

export interface QboAccount {
  Id: string;
  Name: string;
  AcctNum?: string;
  Classification?: "Asset" | "Liability" | "Equity" | "Revenue" | "Expense";
  AccountType?: string;
  AccountSubType?: string;
  CurrentBalance?: number;
}

export interface NahbAccount {
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "cogs" | "expense";
}

export interface AccountMapping {
  qboId: string;
  qboName: string;
  nahbCode: string;
  nahbName: string;
  via: "number" | "name" | "type-default";
}

export interface MappingResult {
  mapped: AccountMapping[];
  /** QBO accounts we could not confidently map — the human resolves these. */
  unmapped: { qboId: string; qboName: string; qboType: string }[];
}

/** Default NAHB landing account per QBO account type (safe, CPA-legible). */
const TYPE_DEFAULTS: Record<string, string> = {
  Bank: "1020",
  "Accounts Receivable": "1210",
  "Other Current Asset": "1310",
  "Fixed Asset": "1620",
  "Other Asset": "1810",
  "Accounts Payable": "2110",
  "Credit Card": "2210",
  "Other Current Liability": "2300",
  "Long Term Liability": "2610",
  Equity: "2910",
  Income: "3100",
  "Other Income": "9010",
  "Cost of Goods Sold": "3810",
  Expense: "8010",
  "Other Expense": "9510",
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Map QBO accounts onto the tenant's NAHB chart:
 *   1. exact account-number match (AcctNum === NAHB code),
 *   2. normalized name match,
 *   3. QBO AccountType default (always resolvable),
 * and report anything that fell through (no type default) as unmapped.
 */
export function mapQboAccounts(
  qboAccounts: QboAccount[],
  chart: NahbAccount[],
): MappingResult {
  const byCode = new Map(chart.map((a) => [a.code, a]));
  const byName = new Map(chart.map((a) => [norm(a.name), a]));
  const mapped: AccountMapping[] = [];
  const unmapped: MappingResult["unmapped"] = [];

  for (const q of qboAccounts) {
    const numHit = q.AcctNum ? byCode.get(q.AcctNum.trim()) : undefined;
    if (numHit) {
      mapped.push({
        qboId: q.Id,
        qboName: q.Name,
        nahbCode: numHit.code,
        nahbName: numHit.name,
        via: "number",
      });
      continue;
    }
    const nameHit = byName.get(norm(q.Name));
    if (nameHit) {
      mapped.push({
        qboId: q.Id,
        qboName: q.Name,
        nahbCode: nameHit.code,
        nahbName: nameHit.name,
        via: "name",
      });
      continue;
    }
    const defCode = q.AccountType ? TYPE_DEFAULTS[q.AccountType] : undefined;
    const def = defCode ? byCode.get(defCode) : undefined;
    if (def) {
      mapped.push({
        qboId: q.Id,
        qboName: q.Name,
        nahbCode: def.code,
        nahbName: def.name,
        via: "type-default",
      });
      continue;
    }
    unmapped.push({
      qboId: q.Id,
      qboName: q.Name,
      qboType: q.AccountType ?? q.Classification ?? "unknown",
    });
  }
  return { mapped, unmapped };
}

// ---------------------------------------------------------------- opening TB
export interface QboTbRow {
  qboAccountId: string;
  /** Signed cents, debit-positive (as read off QBO's TrialBalance report). */
  balanceCents: number;
}

export interface OpeningEntryLine {
  accountCode: string;
  debitCents: number;
  creditCents: number;
}

export interface OpeningEntry {
  lines: OpeningEntryLine[];
  totalDebitsCents: number;
  totalCreditsCents: number;
  /** A source TB that doesn't balance is a data problem — refuse to post. */
  balanced: boolean;
}

/**
 * Fold a QBO trial balance through the account mapping into ONE opening
 * journal entry. Multiple QBO accounts mapping to the same NAHB account
 * merge into one line. Zero balances drop.
 */
export function buildOpeningEntry(
  tb: QboTbRow[],
  mapping: AccountMapping[],
): OpeningEntry {
  const codeFor = new Map(mapping.map((m) => [m.qboId, m.nahbCode]));
  const byCode = new Map<string, number>();
  for (const row of tb) {
    const code = codeFor.get(row.qboAccountId);
    if (!code || row.balanceCents === 0) continue;
    byCode.set(code, (byCode.get(code) ?? 0) + row.balanceCents);
  }
  const lines: OpeningEntryLine[] = [...byCode.entries()]
    .filter(([, bal]) => bal !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([accountCode, bal]) => ({
      accountCode,
      debitCents: bal > 0 ? bal : 0,
      creditCents: bal < 0 ? -bal : 0,
    }));
  const totalDebitsCents = lines.reduce((t, l) => t + l.debitCents, 0);
  const totalCreditsCents = lines.reduce((t, l) => t + l.creditCents, 0);
  return {
    lines,
    totalDebitsCents,
    totalCreditsCents,
    balanced: totalDebitsCents === totalCreditsCents,
  };
}

/** Dollars (QBO reports amounts as decimal strings/numbers) → integer cents. */
export function qboAmountToCents(v: string | number | undefined): number {
  if (v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`unparseable QBO amount: ${v}`);
  return Math.round(n * 100);
}
