// Sales tax — a STATE-AGNOSTIC engine. Rates and method come from the
// tenant's tax profile, resolved at signup/onboarding from the customer's
// actual state (and kept current there) — NOTHING here is hardcoded to any
// state. The profile picks the computation method; the math is pure.
//
// Methods cover the real regimes US contractors face:
//   none            — no sales tax (e.g. states with no general sales tax)
//   retail          — tax on the full invoice at combined rates
//   gross-factor    — tax on a statutory factor of gross (e.g. a 65% factor
//                     used by prime-contracting regimes)
//   materials-cost  — tax on the cost of materials only (repair/replace/
//                     maintenance-style regimes)
// Tax ALWAYS accrues to a tax-payable liability — never to revenue.
import { assertCents, formatMoney, mulDivHalfUp, type Cents } from "@/lib/money/cents";
import { JobCostError } from "./wip";

export type TaxMethod = "none" | "retail" | "gross-factor" | "materials-cost";

export interface TaxProfile {
  method: TaxMethod;
  /** Combined jurisdiction rates, basis points. Set only what applies. */
  stateBps?: number;
  countyBps?: number;
  cityBps?: number;
  /** For gross-factor: the statutory taxable share of gross, bps (e.g. 6500). */
  factorBps?: number;
}

export interface TaxInput {
  invoiceCents: Cents;
  /** Required for the materials-cost method. */
  materialsCostCents?: Cents;
}

export interface TaxResult {
  taxableBaseCents: Cents;
  stateTaxCents: Cents;
  countyTaxCents: Cents;
  cityTaxCents: Cents;
  totalTaxCents: Cents;
}

function bps(n: number | undefined, name: string): number {
  const v = n ?? 0;
  if (!Number.isInteger(v) || v < 0 || v > 2000) {
    // No US sales-tax jurisdiction exceeds 20%; beyond that is a data bug.
    throw new JobCostError(`tax_rate_out_of_range:${name}`);
  }
  return v;
}

export function computeTax(profile: TaxProfile, input: TaxInput): TaxResult {
  const invoice = assertCents(input.invoiceCents);
  if (invoice < 0) throw new JobCostError("tax_invoice_must_be_nonnegative");

  const state = bps(profile.stateBps, "state");
  const county = bps(profile.countyBps, "county");
  const city = bps(profile.cityBps, "city");

  let base: Cents;
  switch (profile.method) {
    case "none":
      return {
        taxableBaseCents: 0,
        stateTaxCents: 0,
        countyTaxCents: 0,
        cityTaxCents: 0,
        totalTaxCents: 0,
      };
    case "retail":
      base = invoice;
      break;
    case "gross-factor": {
      const factor = profile.factorBps ?? 0;
      if (!Number.isInteger(factor) || factor <= 0 || factor > 10_000) {
        throw new JobCostError("tax_factor_required_for_gross_factor");
      }
      base = mulDivHalfUp(invoice, factor, 10_000);
      break;
    }
    case "materials-cost": {
      const materials = input.materialsCostCents;
      if (materials === undefined) {
        throw new JobCostError("tax_materials_cost_required");
      }
      base = assertCents(materials);
      if (base < 0) throw new JobCostError("tax_materials_must_be_nonnegative");
      break;
    }
  }

  const stateTax = mulDivHalfUp(base, state, 10_000);
  const countyTax = mulDivHalfUp(base, county, 10_000);
  const cityTax = mulDivHalfUp(base, city, 10_000);
  return {
    taxableBaseCents: base,
    stateTaxCents: stateTax,
    countyTaxCents: countyTax,
    cityTaxCents: cityTax,
    totalTaxCents: stateTax + countyTax + cityTax,
  };
}

export function explainTax(r: TaxResult): string {
  if (r.totalTaxCents === 0) {
    return "No sales tax applies to this invoice in your state.";
  }
  return `$${formatMoney(r.totalTaxCents)} of this invoice is sales tax. That money is NOT yours — it belongs to the state. We set it aside so the tax bill never surprises you.`;
}
