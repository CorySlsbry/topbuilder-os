// Burdened labor — hours × a fully-loaded rate from the app-side rate table.
// We compute burden ourselves (payroll systems rarely expose true cost rates).
// All rates are tenant-configured inputs — nothing state- or client-specific
// is hardcoded. Pure, integer cents.
import { assertCents, formatMoney, mulDivHalfUp, type Cents } from "@/lib/money/cents";
import { JobCostError } from "./wip";

export interface BurdenRate {
  /** Base hourly wage, cents. */
  baseHourlyCents: Cents;
  /** Employer FICA in basis points of wages (e.g. 765 = 7.65%). */
  ficaBps: number;
  /** FUTA/SUTA and other wage-percentage taxes, bps of wages. */
  unemploymentBps?: number;
  /**
   * Workers' comp premium in cents per $100 of wages — numerically identical
   * to bps of wages ($15.00 per $100 → 1500 → 15%). Class-specific: the rate
   * table carries one rate per WC class, keyed by the tenant's classes.
   */
  wcPer100Cents?: number;
  /** Flat benefits cost per hour worked (health, retirement match), cents. */
  benefitsHourlyCents?: Cents;
  /** Anything else expressed as bps of wages (liability insurance, etc.). */
  otherBps?: number;
}

export interface BurdenedLabor {
  wagesCents: Cents; // gross wages incl. OT premium
  burdenCents: Cents; // employer taxes + WC + benefits
  totalCents: Cents; // what the hour actually costs the job
}

/**
 * hours at straight time, otHours at 1.5×. Percentage burdens apply to ALL
 * wages (incl. the OT premium — that's how FICA/WC actually work); flat
 * benefits apply per hour worked.
 */
export function computeBurdenedLabor(
  hoursX100: number, // hours in hundredths (7.25h → 725) — integers only
  otHoursX100: number,
  rate: BurdenRate,
): BurdenedLabor {
  if (!Number.isInteger(hoursX100) || !Number.isInteger(otHoursX100) || hoursX100 < 0 || otHoursX100 < 0) {
    throw new JobCostError("hours_must_be_nonnegative_integer_hundredths");
  }
  const base = assertCents(rate.baseHourlyCents);
  if (base <= 0) {
    // A zero rate would silently post $0 burden — that is a data bug, not a
    // free employee. Hard error, always.
    throw new JobCostError("labor_rate_missing_or_zero");
  }

  const straight = mulDivHalfUp(base, hoursX100, 100);
  const ot = mulDivHalfUp(mulDivHalfUp(base, 3, 2), otHoursX100, 100); // 1.5×
  const wages = straight + ot;

  const pctBps =
    rate.ficaBps + (rate.unemploymentBps ?? 0) + (rate.wcPer100Cents ?? 0) + (rate.otherBps ?? 0);
  const pctBurden = mulDivHalfUp(wages, pctBps, 10_000);
  const benefits = mulDivHalfUp(
    assertCents(rate.benefitsHourlyCents ?? 0),
    hoursX100 + otHoursX100,
    100,
  );

  const burden = pctBurden + benefits;
  return { wagesCents: wages, burdenCents: burden, totalCents: wages + burden };
}

export function explainBurden(r: BurdenedLabor): string {
  return `Wages were $${formatMoney(r.wagesCents)}, but with payroll taxes, insurance, and benefits the real cost was $${formatMoney(r.totalCents)}. Every hour costs more than the paycheck shows — price your jobs on the real number.`;
}
