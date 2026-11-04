/**
 * Integer-cents money primitives.
 *
 * ALL money in the system is stored and computed as integer cents — never
 * floats. Ratios (percent-complete, tax rates) use decimal math and round
 * half-up to cents at the boundary, asserted in tests. These primitives are
 * the foundation the ledger (S2) and money-math suite (S3) build on.
 *
 * Pure, deterministic, no I/O — safe to unit-test exhaustively.
 */
export type Cents = number;

/** Throws unless `n` is a safe integer number of cents. */
export function assertCents(n: number): Cents {
  if (!Number.isInteger(n) || !Number.isSafeInteger(n)) {
    throw new Error(`not integer cents: ${n}`);
  }
  return n;
}

/** Sum a list of cents; asserts every input and the result stay integral. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += assertCents(v);
  return assertCents(total);
}

/**
 * (a × b) / d rounded HALF-UP, computed in BigInt so intermediate products
 * can't overflow doubles (contract × costs easily exceeds 2^53). The single
 * rounding primitive every ratio in the money math goes through — one rule,
 * asserted everywhere.
 */
export function mulDivHalfUp(a: number, b: number, d: number): Cents {
  assertCents(a);
  assertCents(b);
  assertCents(d);
  if (d === 0) throw new Error("mulDivHalfUp: division by zero");
  const A = BigInt(a) * BigInt(b);
  const D = BigInt(d);
  const sign = A < 0n !== D < 0n ? -1n : 1n;
  const absA = A < 0n ? -A : A;
  const absD = D < 0n ? -D : D;
  const q = (absA * 2n + absD) / (absD * 2n); // half-up on |A|/|D|
  const out = Number(sign * q);
  return assertCents(out);
}

/** Format cents as a plain decimal string, e.g. 123456 → "1234.56". */
export function formatCents(cents: Cents): string {
  assertCents(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100);
  const rem = abs % 100;
  return `${sign}${dollars}.${rem.toString().padStart(2, "0")}`;
}

/**
 * The same amount, for PROSE — with thousands separators.
 *
 * `formatCents` above is the canonical machine form: `parseDollarsToCents`
 * round-trips it, and a property test pins that. Commas would break the
 * round trip, so the grouped form is a separate function rather than a
 * change to that one.
 *
 * It exists because the two sat side by side on a card and looked like a bug:
 * the stat read "$6,000.00" and the sentence under it read "$6000.00". Both
 * correct, and an owner reading their own money at a kitchen table should
 * never have to wonder which number to trust.
 *
 * Grouping is hand-rolled rather than `toLocaleString`, because these strings
 * are golden-tested on the server and ICU data varies between Node builds and
 * container images — a figure that renders differently in production than in
 * CI is the exact class of thing this codebase refuses to ship.
 */
export function formatMoney(cents: Cents): string {
  const plain = formatCents(cents);
  const neg = plain.startsWith("-");
  const [whole, frac] = (neg ? plain.slice(1) : plain).split(".") as [string, string];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}.${frac}`;
}

/** Parse a dollar string ("1234.56", "-0.07") to integer cents (half-up). */
export function parseDollarsToCents(input: string): Cents {
  const trimmed = input.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`not a dollar amount: ${input}`);
  }
  const negative = trimmed.startsWith("-");
  const [whole, frac = ""] = trimmed.replace("-", "").split(".");
  // Round the fractional part half-up to 2 decimal places.
  const frac2 = frac.slice(0, 2).padEnd(2, "0");
  const third = frac.charCodeAt(2) - 48; // NaN if absent
  let cents = Number(whole) * 100 + Number(frac2);
  if (third >= 5) cents += 1;
  return assertCents(negative ? -cents : cents);
}
