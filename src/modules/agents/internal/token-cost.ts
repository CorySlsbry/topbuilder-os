// Token -> money, in ONE place.
//
// PURE — no I/O, no server-only marker — so the arithmetic that decides whether
// a shop's helper budget is spent can be tested in milliseconds.
//
// ⛔ WHAT THIS IS, AND WHAT IT IS NOT.
// This is a SAFETY RAIL, not an invoice. Nobody is billed from this number. Its
// only job is to make a spend cap able to trip before a runaway loop costs more
// than the plan it runs on. So the requirements are, in order:
//   1. never silently read ZERO (a cap fed zero is not a cap),
//   2. over-estimate rather than under-estimate when unsure,
//   3. say where its numbers came from and let them be corrected without a
//      deploy, because published prices change and this file will go stale.
//
// ⛔ THE RATES BELOW ARE APPROXIMATE AND WILL DRIFT. They are Anthropic's
// published per-million-token list prices as understood when this file was
// written (2026-08-15) — NOT read from a live billing API, and not verified
// against an invoice. Treat them as the order of magnitude they are. Every one
// is overridable at runtime via AGENT_MODEL_RATES (see below), which is the
// intended way to correct them: change the env var, not this file, so a rate
// fix does not need a code review at 3am.
//
// Two deliberate conservative choices, both in the "cap trips sooner" direction:
//   - cache reads are billed at a fraction of input, and we count them as full
//     input, so a cached-heavy workload is over-charged here;
//   - an UNKNOWN model is charged at the most expensive known rate.

export interface ModelRate {
  /** USD per million INPUT tokens. */
  inPerMTok: number;
  /** USD per million OUTPUT tokens. */
  outPerMTok: number;
}

/**
 * Published list prices, approximate. Keys are matched by PREFIX, longest
 * first, so a dated model id (`claude-haiku-4-5-20251001`) resolves without
 * having to be listed by its exact snapshot.
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  "claude-haiku-4-5": { inPerMTok: 1, outPerMTok: 5 },
  "claude-haiku": { inPerMTok: 1, outPerMTok: 5 },
  "claude-sonnet": { inPerMTok: 3, outPerMTok: 15 },
  "claude-opus": { inPerMTok: 15, outPerMTok: 75 },
};

/**
 * Runtime override, so a price change is an env edit rather than a deploy.
 * Format: `model-prefix:in/out,model-prefix:in/out`
 *   AGENT_MODEL_RATES="claude-haiku-4-5:1.10/5.50,claude-sonnet:3/15"
 *
 * A malformed entry is IGNORED rather than fatal — a typo in an env var must
 * not take the product down — but it is logged, because a silently ignored
 * rate override is how you end up metering with numbers you think you changed.
 */
export function ratesFromEnv(raw: string | undefined): Record<string, ModelRate> {
  if (!raw?.trim()) return {};
  const out: Record<string, ModelRate> = {};
  for (const part of raw.split(",")) {
    const [prefix, pair] = part.split(":");
    const [i, o] = (pair ?? "").split("/");
    const inPerMTok = Number(i);
    const outPerMTok = Number(o);
    if (!prefix?.trim() || !Number.isFinite(inPerMTok) || !Number.isFinite(outPerMTok)) {
      console.error("[token-cost] ignoring malformed AGENT_MODEL_RATES entry: %s", part);
      continue;
    }
    if (inPerMTok < 0 || outPerMTok < 0) {
      console.error("[token-cost] ignoring negative AGENT_MODEL_RATES entry: %s", part);
      continue;
    }
    out[prefix.trim()] = { inPerMTok, outPerMTok };
  }
  return out;
}

/** The priciest rate we know about — what an unrecognised model is charged. */
export function worstRate(table: Record<string, ModelRate>): ModelRate {
  const all = Object.values(table);
  if (!all.length) return { inPerMTok: 15, outPerMTok: 75 };
  return all.reduce((a, b) => (b.inPerMTok + b.outPerMTok > a.inPerMTok + a.outPerMTok ? b : a));
}

/**
 * Resolve the rate for a model id.
 *
 * ⛔ An unknown model returns the MOST EXPENSIVE known rate, never zero and
 * never a guess at "probably cheap". Getting a new model wrong in the expensive
 * direction costs a prematurely-tripped cap and one support message. Getting it
 * wrong in the cheap direction costs an unbounded bill, which is the failure
 * this whole file exists to prevent.
 */
export function rateFor(model: string, overrides: Record<string, ModelRate> = {}): ModelRate {
  const table = { ...MODEL_RATES, ...overrides };
  const keys = Object.keys(table).sort((a, b) => b.length - a.length); // longest prefix wins
  for (const k of keys) if (model.startsWith(k)) return table[k]!;
  return worstRate(table);
}

/**
 * Cost of one model call, in integer micro-USD (1e-6 USD) to match
 * `agent_daily_costs.cost_microusd` and `assist_usage.cost_microusd`.
 *
 * Rounded UP: a call that costs a fraction of a micro-dollar must not round to
 * zero, or a million tiny calls sum to nothing — which is precisely the shape
 * of the bug this replaces.
 */
export function costMicroUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  overrides: Record<string, ModelRate> = {},
): number {
  const rate = rateFor(model, overrides);
  const inTok = Math.max(0, Math.trunc(inputTokens || 0));
  const outTok = Math.max(0, Math.trunc(outputTokens || 0));
  if (inTok === 0 && outTok === 0) return 0;
  const usd = (inTok / 1_000_000) * rate.inPerMTok + (outTok / 1_000_000) * rate.outPerMTok;
  return Math.max(1, Math.ceil(usd * 1_000_000));
}

/**
 * Has this tenant spent its day's allowance?
 *
 * Split out from the query so the DECISION is testable without a database —
 * the runbook's done-condition is "a test proves the cap actually TRIPS", and a
 * cap that has never been observed to fire is indistinguishable from no cap.
 *
 * `>=` not `>`: landing exactly on the cap has spent the cap.
 */
export function overBudget(spentMicroUsd: number, capMicroUsd: number): boolean {
  if (!(capMicroUsd > 0)) return true; // a cap of zero (or nonsense) is a kill switch
  return spentMicroUsd >= capMicroUsd;
}
