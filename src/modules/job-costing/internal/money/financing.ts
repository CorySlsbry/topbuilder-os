// Consumer-financing display math — pure, deterministic, integer cents.
//
// "As low as $X/mo" on good-better-best options is the proven closer the
// incumbents charge for. WE only DISPLAY the standard amortized payment for
// the configured partner terms — the actual credit decision always belongs
// to the financing partner (link-out). Figures verbatim, never invented.
import { mulDivHalfUp } from "@/lib/money/cents";

export interface FinancingTerms {
  /** Annual rate in basis points (999 = 9.99% APR). */
  aprBps: number;
  termMonths: number;
  /** Partner application URL; empty = no apply link shown. */
  applyUrl: string;
}

/** Standard amortized monthly payment, half-up cents. 0% APR = principal/n. */
export function monthlyPaymentCents(principalCents: number, terms: FinancingTerms): number {
  if (!Number.isSafeInteger(principalCents) || principalCents <= 0) {
    throw new Error("principal_must_be_positive_cents");
  }
  if (terms.termMonths <= 0 || !Number.isInteger(terms.termMonths)) {
    throw new Error("term_must_be_positive_months");
  }
  if (terms.aprBps === 0) {
    return mulDivHalfUp(principalCents, 1, terms.termMonths);
  }
  // i = monthly rate; payment = P * i / (1 - (1+i)^-n)
  const i = terms.aprBps / 10_000 / 12;
  const factor = i / (1 - Math.pow(1 + i, -terms.termMonths));
  return Math.round(principalCents * factor);
}

export function explainFinancing(principalCents: number, terms: FinancingTerms): string {
  const m = monthlyPaymentCents(principalCents, terms);
  const d = (c: number) =>
    `$${Math.floor(c / 100).toLocaleString("en-US")}.${String(c % 100).padStart(2, "0")}`;
  return `As low as ${d(m)}/mo for ${terms.termMonths} months (${(terms.aprBps / 100).toFixed(2)}% APR, on approved credit through our financing partner).`;
}
