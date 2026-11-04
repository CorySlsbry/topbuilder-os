import type { Signal, Target } from "./signals";

/**
 * The outreach composer — customer-facing words for the sales agent.
 *
 * Pure and deterministic, same discipline as the signals engine it reads
 * from: no model writes these, every number comes from the signal's own
 * `facts`, and the `figures` array names every number the message contains
 * so the figure firewall can hold any future drafted variant to the same
 * set. The internal reason strings are OWNER-facing ("they declined a
 * $12,400 quote"); these are the words a CUSTOMER reads, so they are
 * composed fresh here rather than pasted through.
 *
 * One draft per customer, from their heaviest visible signal — an owner
 * approving five texts to the same household is spam with extra steps.
 */

export interface OutreachDraft {
  /** which signal the message answers — dispositions and idempotency pin here */
  signalKey: string;
  /** the owner-facing reason, for the approval card */
  reason: string;
  /** the customer-facing message (SMS/email body) */
  message: string;
  /** every number the message quotes, cents as cents — the firewall's universe */
  figures: (string | number)[];
}

/** Heaviest signal first; ties break by key so the pick never reshuffles. */
function topSignal(signals: Signal[]): Signal | null {
  if (signals.length === 0) return null;
  return [...signals].sort(
    (a, b) => b.weight - a.weight || a.key.localeCompare(b.key),
  )[0]!;
}

/** Exact, never rounded: a rounded figure is a number the book never held,
 *  and it would fail the firewall against its own declared cents. */
const fmt = (cents: number) => {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0
    ? `$${whole.toLocaleString("en-US")}`
    : `$${whole.toLocaleString("en-US")}.${String(rest).padStart(2, "0")}`;
};

export function outreachDraft(target: Target, businessName: string): OutreachDraft | null {
  const s = topSignal(target.signals);
  if (!s) return null;

  const biz = businessName.trim() || "your service team";
  // A business name can legitimately carry digits ("Acme Home Services").
  // Those tokens are part of every message, so they join the allowed set —
  // otherwise the firewall would flag the shop's own name as a drifted figure.
  const nameFigures = biz.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];

  let message: string;
  let figures: (string | number)[] = [];

  if (s.key.startsWith("equipment-aging:")) {
    const unit = String(s.facts.unit ?? "unit");
    const age = Number(s.facts.ageYears ?? 0);
    const life = Number(s.facts.life ?? 0);
    message = s.facts.past
      ? `Hi, it's ${biz}. Your ${unit} is ${age} years old now, past the ${life} or so they usually give. If it quits mid-season that becomes an emergency call. Want a free quote on a planned replacement instead?`
      : `Hi, it's ${biz}. Your ${unit} is ${age} years old, and most run about ${life}. No rush today, but a planned replacement always beats an emergency one. Want a free quote to keep on hand?`;
    figures = [age, life];
  } else if (s.key === "agreement-past-due") {
    message = `Hi, it's ${biz}. It looks like your maintenance plan payment did not go through. Easy fix if the card changed. Want me to send a fresh payment link so your visits and member pricing keep going?`;
  } else if (s.key === "agreement-lapsed") {
    message = `Hi, it's ${biz}. Your maintenance plan lapsed a while back, and members get priority scheduling and their tune-ups covered. Want me to reinstate it at the same rate you had?`;
  } else if (s.key === "agreement-renewal") {
    const days = Number(s.facts.endsInDays ?? 0);
    message = `Hi, it's ${biz}. Your maintenance plan wraps up in ${days} day${days === 1 ? "" : "s"}. Renewing now keeps your tune-ups and member pricing with no gap. Want me to set that up?`;
    figures = [days];
  } else if (s.key.startsWith("quote-declined:")) {
    const cents = Number(s.facts.totalCents ?? 0);
    const months = Number(s.facts.months ?? 1);
    message = `Hi, it's ${biz}. About ${months} month${months === 1 ? "" : "s"} ago we quoted ${fmt(cents)} for work at your place and the timing was not right. Budgets and prices both move. Want us to take a fresh look at the numbers?`;
    figures = [months, cents];
  } else if (s.key === "gone-quiet") {
    const months = Number(s.facts.months ?? 0);
    message = `Hi, it's ${biz}. It has been about ${months} months since we were last out your way. Want us to get a tune-up on the books before the busy season hits?`;
    figures = [months];
  } else {
    // A signal kind this composer does not know yet: stay generic rather
    // than guess. The reason still tells the owner why they are calling.
    message = `Hi, it's ${biz}. We were looking at your service history and wanted to check in. Anything around the house we should take a look at this season?`;
  }

  return {
    signalKey: s.key,
    reason: s.reason,
    message,
    figures: [...figures, ...nameFigures],
  };
}
