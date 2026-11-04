/**
 * The cost-code presets a shop starts from.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 * Cost codes are the spine of construction accounting. They are the
 * dimension that makes job costing, the WIP schedule, a schedule of values
 * and an underwriter's contracts-in-progress report say anything at all.
 * Until now this product hardcoded `4100` on every job cost it posted, which
 * meant the by-code breakdown on the job screen grouped the entire business
 * into one row, and the estimate-vs-actual loop that is supposed to make the
 * next bid better had nothing to compare on.
 *
 * ── WHY PRESETS RATHER THAN ONE FIXED LIST ───────────────────────────────
 * A roofer's codes and an electrician's codes share almost nothing except
 * general conditions. This product already chose "fit how any company runs"
 * when it built dynamic departments; a single fixed chart contradicts that.
 * Every preset is a STARTING POINT — rename, deactivate and add freely.
 *
 * ── THE TWO-LEVEL SHAPE, AND WHY ─────────────────────────────────────────
 * `DD-NNN`: a two-digit division and a three-digit item. Division numbers on
 * the trade sets follow CSI MasterFormat where a natural one exists (23 for
 * HVAC, 22 plumbing, 26 electrical, 07 roofing / thermal & moisture), so a
 * shop that later bids commercial work is already speaking the general
 * contractor's language on its schedule of values. `sort_order` carries the
 * real ordering because these sort as TEXT in the database.
 *
 * ── `kind` IS NOT DECORATION ─────────────────────────────────────────────
 * labor / material / sub / equipment / other drives burdened-labor math, the
 * crew-vs-materials split on the job report, and the labor line an
 * underwriter looks for. Getting it wrong is a wrong number, not a wrong
 * label — which is why every entry below states it explicitly rather than
 * inferring it from the name.
 */

export type CostKind = "labor" | "material" | "sub" | "equipment" | "other";

export interface CostCodeSeed {
  code: string;
  name: string;
  kind: CostKind;
  division: string;
}

export interface CostCodePreset {
  key: string;
  label: string;
  /** One line the owner reads before committing to ~25 rows in their books. */
  blurb: string;
  codes: CostCodeSeed[];
}

/**
 * General conditions — the costs that belong to the JOB but not to any
 * phase of the work. Shared by every preset, because every trade has them
 * and every trade forgets to code them, which is how a job looks profitable
 * until the dumpster invoice arrives.
 */
const GENERAL: CostCodeSeed[] = [
  { code: "01-100", name: "Job supervision", kind: "labor", division: "01 General conditions" },
  { code: "01-200", name: "Permits & inspections", kind: "other", division: "01 General conditions" },
  { code: "01-300", name: "Dumpster & disposal", kind: "other", division: "01 General conditions" },
  { code: "01-400", name: "Equipment rental", kind: "equipment", division: "01 General conditions" },
  { code: "01-500", name: "Travel, fuel & mileage", kind: "other", division: "01 General conditions" },
  { code: "01-600", name: "Small tools & consumables", kind: "material", division: "01 General conditions" },
  { code: "01-700", name: "Job-specific insurance & bonds", kind: "other", division: "01 General conditions" },
  { code: "01-800", name: "Warranty & callback labor", kind: "labor", division: "01 General conditions" },
  { code: "01-900", name: "Other job cost", kind: "other", division: "01 General conditions" },
];

const HVAC: CostCodeSeed[] = [
  { code: "23-100", name: "Condensers & heat pumps", kind: "material", division: "23 HVAC" },
  { code: "23-110", name: "Furnaces & air handlers", kind: "material", division: "23 HVAC" },
  { code: "23-120", name: "Mini-split systems", kind: "material", division: "23 HVAC" },
  { code: "23-130", name: "Package units / RTUs", kind: "material", division: "23 HVAC" },
  { code: "23-200", name: "Ductwork & fittings", kind: "material", division: "23 HVAC" },
  { code: "23-210", name: "Sheet metal fabrication", kind: "sub", division: "23 HVAC" },
  { code: "23-220", name: "Duct install labor", kind: "labor", division: "23 HVAC" },
  { code: "23-300", name: "Refrigerant, lineset & fittings", kind: "material", division: "23 HVAC" },
  { code: "23-400", name: "Controls & thermostats", kind: "material", division: "23 HVAC" },
  { code: "23-500", name: "Install labor", kind: "labor", division: "23 HVAC" },
  { code: "23-510", name: "Service & repair labor", kind: "labor", division: "23 HVAC" },
  { code: "23-520", name: "Startup & commissioning", kind: "labor", division: "23 HVAC" },
  { code: "23-600", name: "Crane & rigging", kind: "sub", division: "23 HVAC" },
  { code: "22-100", name: "Condensate & drain material", kind: "material", division: "22 Plumbing" },
  { code: "26-100", name: "Electrical material", kind: "material", division: "26 Electrical" },
  { code: "26-200", name: "Electrical subcontractor", kind: "sub", division: "26 Electrical" },
];

const ROOFING: CostCodeSeed[] = [
  { code: "02-100", name: "Tear-off labor", kind: "labor", division: "02 Existing conditions" },
  { code: "06-100", name: "Decking & sheathing material", kind: "material", division: "06 Wood & plastics" },
  { code: "06-200", name: "Decking & repair labor", kind: "labor", division: "06 Wood & plastics" },
  { code: "07-100", name: "Underlayment & ice/water", kind: "material", division: "07 Thermal & moisture" },
  { code: "07-200", name: "Shingles", kind: "material", division: "07 Thermal & moisture" },
  { code: "07-210", name: "Tile", kind: "material", division: "07 Thermal & moisture" },
  { code: "07-220", name: "Metal roofing", kind: "material", division: "07 Thermal & moisture" },
  { code: "07-230", name: "Flat / membrane roofing", kind: "material", division: "07 Thermal & moisture" },
  { code: "07-300", name: "Flashing & sheet metal", kind: "material", division: "07 Thermal & moisture" },
  { code: "07-400", name: "Ventilation", kind: "material", division: "07 Thermal & moisture" },
  { code: "07-500", name: "Roofing install labor", kind: "labor", division: "07 Thermal & moisture" },
  { code: "07-600", name: "Roofing subcontractor", kind: "sub", division: "07 Thermal & moisture" },
  { code: "07-700", name: "Gutters & downspouts", kind: "sub", division: "07 Thermal & moisture" },
  { code: "01-410", name: "Crane, conveyor & lift", kind: "equipment", division: "01 General conditions" },
];

const ELECTRICAL: CostCodeSeed[] = [
  { code: "26-100", name: "Wire & cable", kind: "material", division: "26 Electrical" },
  { code: "26-110", name: "Conduit & fittings", kind: "material", division: "26 Electrical" },
  { code: "26-120", name: "Boxes, devices & plates", kind: "material", division: "26 Electrical" },
  { code: "26-200", name: "Panels & breakers", kind: "material", division: "26 Electrical" },
  { code: "26-210", name: "Service & meter equipment", kind: "material", division: "26 Electrical" },
  { code: "26-300", name: "Lighting fixtures", kind: "material", division: "26 Electrical" },
  { code: "26-400", name: "Generators & transfer switches", kind: "material", division: "26 Electrical" },
  { code: "26-500", name: "Rough-in labor", kind: "labor", division: "26 Electrical" },
  { code: "26-510", name: "Trim-out labor", kind: "labor", division: "26 Electrical" },
  { code: "26-520", name: "Service & troubleshooting labor", kind: "labor", division: "26 Electrical" },
  { code: "26-600", name: "Electrical subcontractor", kind: "sub", division: "26 Electrical" },
  { code: "27-100", name: "Low voltage & data", kind: "material", division: "27 Communications" },
  { code: "31-100", name: "Trenching & backfill", kind: "sub", division: "31 Earthwork" },
];

const PLUMBING: CostCodeSeed[] = [
  { code: "22-100", name: "Pipe & fittings", kind: "material", division: "22 Plumbing" },
  { code: "22-110", name: "Valves & specialties", kind: "material", division: "22 Plumbing" },
  { code: "22-200", name: "Fixtures", kind: "material", division: "22 Plumbing" },
  { code: "22-300", name: "Water heaters & tankless", kind: "material", division: "22 Plumbing" },
  { code: "22-400", name: "Drain, waste & vent material", kind: "material", division: "22 Plumbing" },
  { code: "22-500", name: "Rough-in labor", kind: "labor", division: "22 Plumbing" },
  { code: "22-510", name: "Trim-out labor", kind: "labor", division: "22 Plumbing" },
  { code: "22-520", name: "Service & drain-clearing labor", kind: "labor", division: "22 Plumbing" },
  { code: "22-600", name: "Plumbing subcontractor", kind: "sub", division: "22 Plumbing" },
  { code: "21-100", name: "Fire suppression", kind: "sub", division: "21 Fire suppression" },
  { code: "31-100", name: "Excavation & trenching", kind: "sub", division: "31 Earthwork" },
  { code: "03-100", name: "Concrete cutting & patching", kind: "sub", division: "03 Concrete" },
];

/**
 * The CSI division set, for a shop that bids commercial work. A general
 * contractor's schedule of values is organised this way, so a subcontractor
 * whose own codes already line up with it can produce a G703 that the GC's
 * project manager can read without translating anything.
 */
const COMMERCIAL: CostCodeSeed[] = [
  { code: "02-000", name: "Existing conditions & demolition", kind: "sub", division: "02 Existing conditions" },
  { code: "03-000", name: "Concrete", kind: "sub", division: "03 Concrete" },
  { code: "04-000", name: "Masonry", kind: "sub", division: "04 Masonry" },
  { code: "05-000", name: "Metals", kind: "sub", division: "05 Metals" },
  { code: "06-000", name: "Wood, plastics & composites", kind: "material", division: "06 Wood & plastics" },
  { code: "07-000", name: "Thermal & moisture protection", kind: "sub", division: "07 Thermal & moisture" },
  { code: "08-000", name: "Openings — doors & windows", kind: "material", division: "08 Openings" },
  { code: "09-000", name: "Finishes", kind: "sub", division: "09 Finishes" },
  { code: "10-000", name: "Specialties", kind: "material", division: "10 Specialties" },
  { code: "11-000", name: "Equipment", kind: "material", division: "11 Equipment" },
  { code: "21-000", name: "Fire suppression", kind: "sub", division: "21 Fire suppression" },
  { code: "22-000", name: "Plumbing", kind: "sub", division: "22 Plumbing" },
  { code: "23-000", name: "HVAC", kind: "sub", division: "23 HVAC" },
  { code: "26-000", name: "Electrical", kind: "sub", division: "26 Electrical" },
  { code: "27-000", name: "Communications", kind: "sub", division: "27 Communications" },
  { code: "28-000", name: "Electronic safety & security", kind: "sub", division: "28 Electronic safety" },
  { code: "31-000", name: "Earthwork", kind: "sub", division: "31 Earthwork" },
  { code: "32-000", name: "Exterior improvements", kind: "sub", division: "32 Exterior improvements" },
  { code: "33-000", name: "Utilities", kind: "sub", division: "33 Utilities" },
];

export const COST_CODE_PRESETS: CostCodePreset[] = [
  {
    key: "hvac",
    label: "HVAC / mechanical",
    blurb:
      "Equipment, ductwork, linesets, controls, install and service labor — plus the general conditions every job carries.",
    codes: [...GENERAL, ...HVAC],
  },
  {
    key: "roofing",
    label: "Roofing",
    blurb:
      "Tear-off, decking, underlayment, the four roof types, flashing, gutters and the crane — plus general conditions.",
    codes: [...GENERAL, ...ROOFING],
  },
  {
    key: "electrical",
    label: "Electrical",
    blurb:
      "Wire, conduit, panels, fixtures, generators, rough-in and trim-out labor — plus general conditions.",
    codes: [...GENERAL, ...ELECTRICAL],
  },
  {
    key: "plumbing",
    label: "Plumbing",
    blurb:
      "Pipe, fixtures, water heaters, DWV, rough-in and trim-out labor — plus general conditions.",
    codes: [...GENERAL, ...PLUMBING],
  },
  {
    key: "commercial",
    label: "General / commercial (CSI divisions)",
    blurb:
      "The CSI MasterFormat divisions a general contractor organises a schedule of values by. Pick this if you bid commercial work.",
    codes: [...GENERAL, ...COMMERCIAL],
  },
];

/** Dedupes by code (a trade set can legitimately repeat a general code) and
 *  assigns the presentation order the database column carries. */
export function presetRows(preset: CostCodePreset): (CostCodeSeed & { sortOrder: number })[] {
  const seen = new Set<string>();
  const out: (CostCodeSeed & { sortOrder: number })[] = [];
  for (const c of [...preset.codes].sort((a, b) => a.code.localeCompare(b.code))) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    out.push({ ...c, sortOrder: out.length * 10 });
  }
  return out;
}

export function findPreset(key: string): CostCodePreset | undefined {
  return COST_CODE_PRESETS.find((p) => p.key === key);
}
