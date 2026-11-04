/**
 * The signals engine — win-back prospecting from data the shop already owns.
 *
 * This is the honest version of what ServiceTitan pays Convex for: instead of
 * licensed intent feeds, every signal is a FACT from this tenant's own tables,
 * and every reason string names its data so the owner can click through and
 * check it. Nothing here is inferred, scored by a model, or bought.
 *
 * Pure on purpose (the money-math discipline): the store computes day counts
 * and ages in SQL and hands plain numbers in; this file turns them into a
 * ranked list with plain-language reasons. Same rules as the ledger layer —
 * deterministic, integer arithmetic, hand-computed test oracle.
 */

export interface EquipmentFact {
  equipmentId: string;
  label: string;
  kind: string;
  ageYears: number; // whole years since installed_on, floored by the store
}

export interface CustomerFacts {
  customerId: string;
  name: string;
  /** days since the last job's created_at; null = never had a job */
  lastJobDaysAgo: number | null;
  equipment: EquipmentFact[];
  /** null = no agreement ever */
  agreementStatus: "active" | "past_due" | "canceled" | "expired" | null;
  /** days until period_end for an ACTIVE agreement (negative = past) */
  agreementEndsInDays: number | null;
  /** declined estimates in the lookback window */
  declinedQuotes: { estimateId: string; daysAgo: number; totalCents: number }[];
}

export interface Signal {
  /** stable key — dispositions (dismiss/snooze) attach to exactly this */
  key: string;
  reason: string;
  weight: number;
  /** The structured facts behind the reason, so other surfaces (the outreach
   *  composer) can restate them in their own words instead of parsing the
   *  reason prose. Same numbers, different audience. */
  facts: Record<string, string | number>;
}

export interface Target {
  customerId: string;
  name: string;
  score: number;
  signals: Signal[];
}

/**
 * Typical service life by unit kind, in years. Industry rule-of-thumb ranges
 * (ASHRAE-adjacent), used ONLY to decide when a replacement conversation is
 * worth having — the reason string always states the unit's actual age, so
 * the claim being made to the owner is the age, not the prediction.
 */
export const LIFESPAN_YEARS: Record<string, number> = {
  ac: 14,
  "heat-pump": 14,
  furnace: 18,
  "water-heater": 11,
  "mini-split": 16,
  rtu: 17,
  other: 15,
};

const KIND_LABEL: Record<string, string> = {
  ac: "AC",
  "heat-pump": "heat pump",
  furnace: "furnace",
  "water-heater": "water heater",
  "mini-split": "mini-split",
  rtu: "rooftop unit",
  other: "unit",
};

export const QUOTE_LOOKBACK_DAYS = 180;
export const STALE_AFTER_DAYS = 540; // 18 months — a customer going cold
export const RENEWAL_WINDOW_DAYS = 45;

export function customerSignals(f: CustomerFacts): Signal[] {
  const out: Signal[] = [];

  // ── equipment approaching or past its typical life ────────────────────
  for (const e of f.equipment) {
    const life = LIFESPAN_YEARS[e.kind] ?? LIFESPAN_YEARS.other!;
    const unit = KIND_LABEL[e.kind] ?? "unit";
    if (e.ageYears >= life) {
      out.push({
        key: `equipment-aging:${e.equipmentId}`,
        reason: `${e.label || KIND_LABEL[e.kind] || "Unit"} is ${e.ageYears} years old — typical ${unit} life is about ${life}. Replacement conversation, not a repair.`,
        weight: 40 + Math.min(20, (e.ageYears - life) * 5),
        facts: { unit, ageYears: e.ageYears, life, past: 1 },
      });
    } else if (e.ageYears >= life - 2) {
      out.push({
        key: `equipment-aging:${e.equipmentId}`,
        reason: `${e.label || KIND_LABEL[e.kind] || "Unit"} is ${e.ageYears} years old, approaching the typical ${life}-year life for a ${unit}. Good time to plan, before it fails in season.`,
        weight: 25,
        facts: { unit, ageYears: e.ageYears, life, past: 0 },
      });
    }
  }

  // ── the membership going, or gone ──────────────────────────────────────
  if (f.agreementStatus === "past_due") {
    out.push({
      key: "agreement-past-due",
      reason: "Their maintenance membership payment failed and nobody has followed up. A member you already won is the cheapest one to keep.",
      weight: 45,
      facts: {},
    });
  } else if (f.agreementStatus === "expired" || f.agreementStatus === "canceled") {
    out.push({
      key: "agreement-lapsed",
      reason: "Their maintenance membership lapsed. They said yes once.",
      weight: 30,
      facts: {},
    });
  } else if (
    f.agreementStatus === "active" &&
    f.agreementEndsInDays !== null &&
    f.agreementEndsInDays >= 0 &&
    f.agreementEndsInDays <= RENEWAL_WINDOW_DAYS
  ) {
    out.push({
      key: "agreement-renewal",
      reason: `Their membership ends in ${f.agreementEndsInDays} day${f.agreementEndsInDays === 1 ? "" : "s"}. A renewal call now beats a win-back call later.`,
      weight: 20,
      facts: { endsInDays: f.agreementEndsInDays },
    });
  }

  // ── quotes that walked ─────────────────────────────────────────────────
  // Keyed by the ESTIMATE, not by how long ago it was declined: daysAgo
  // ticks up every midnight, and a key that drifts daily would shed its
  // dispositions (a dismissed quote came back the next morning) and defeat
  // any idempotency built on it. Frozen-key law: the key names the record.
  for (const q of f.declinedQuotes) {
    if (q.daysAgo <= QUOTE_LOOKBACK_DAYS) {
      const months = Math.max(1, Math.round(q.daysAgo / 30));
      out.push({
        key: `quote-declined:${q.estimateId}`,
        reason: `They declined a ${formatCents(q.totalCents)} quote about ${months} month${months === 1 ? "" : "s"} ago. Budgets and summers change.`,
        weight: 15 + Math.min(15, Math.floor(q.totalCents / 500_000)), // +1 per $5k, capped
        facts: { totalCents: q.totalCents, months },
      });
    }
  }

  // ── the customer going quiet (only meaningful if they WERE a customer) ─
  if (f.lastJobDaysAgo !== null && f.lastJobDaysAgo >= STALE_AFTER_DAYS && out.length === 0) {
    const months = Math.round(f.lastJobDaysAgo / 30);
    out.push({
      key: "gone-quiet",
      reason: `No work in ${months} months. A tune-up offer keeps you their contractor before somebody else becomes it.`,
      weight: 10,
      facts: { months },
    });
  }

  return out;
}

/** Rank customers by total signal weight. Deterministic: ties break by name
 * then id so the list never reshuffles between loads. */
export function rankTargets(all: CustomerFacts[]): Target[] {
  return all
    .map((f) => {
      const signals = customerSignals(f);
      return {
        customerId: f.customerId,
        name: f.name,
        score: signals.reduce((t, s) => t + s.weight, 0),
        signals,
      };
    })
    .filter((t) => t.signals.length > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.customerId.localeCompare(b.customerId));
}

function formatCents(cents: number): string {
  // Exact, never rounded — the reason's whole claim is that it names the
  // book's own figure, and $8,451 for an $8,450.50 quote is not that figure.
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0
    ? `$${whole.toLocaleString("en-US")}`
    : `$${whole.toLocaleString("en-US")}.${String(rest).padStart(2, "0")}`;
}
