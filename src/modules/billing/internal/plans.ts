// The plan catalog — pure, the single source of truth for what a plan costs
// and how many people it covers. FLAT pricing on purpose: no per-head fee,
// because the per-tech tax is the thing we attack ServiceTitan for.
//
// Price IDs are NEVER hardcoded — Stripe prices are resolved at runtime by
// lookup_key, so the same code works in test and live and survives any
// price object being recreated.

export type PlanKey = "light" | "solo" | "crew" | "shop";

export interface Plan {
  key: PlanKey;
  name: string;
  /** Monthly price in integer cents (display + the price we create in Stripe). */
  priceCents: number;
  /** How many people the plan covers, owner included. */
  seatCap: number;
  lookupKey: string;
  blurb: string;
}

/**
 * The capabilities a plan can fence. Deliberately COARSE and deliberately
 * SHORT: each one is a whole area of the product that a one-person shop does
 * not open, never an individual button. A long list here would be the add-on
 * ladder wearing a different hat.
 */
export type Capability =
  | "dispatch"    // the dispatch board — a solo IS the dispatcher
  | "workforce"   // time tracking, burden, crews, certified payroll — no employees
  | "purchasing"  // purchase orders (recording a supply-house BILL is core, and stays)
  | "inventory"   // stock, reorder points, receiving
  | "bonding"     // WIP schedule, surety pack, AIA progress billing
  | "agents"      // the helper crew + the approvals inbox
  | "comms"       // the shared SMS inbox + a dedicated business number
  | "booksQa";    // "ask your books" — the only multi-turn model loop we run

/**
 * The cheapest plan that unlocks each capability. Anything NOT listed here is
 * available on every plan — which is the important half of this table: the
 * whole money loop (customers, jobs, estimates, invoices, payments, the
 * portal, bank feeds, reconciliation, the double-entry books, job costing,
 * job profit, reports, the CPA pack, export, online booking) is unfenced.
 */
export const CAPABILITY_FLOOR: Record<Capability, PlanKey> = {
  dispatch: "solo",
  workforce: "solo",
  purchasing: "solo",
  inventory: "solo",
  bonding: "solo",
  agents: "solo",
  comms: "solo",
  booksQa: "solo",
};

/** Cheapest-first rank, derived from PLAN_LIST so it cannot drift from it. */
function rank(key: PlanKey): number {
  return PLAN_LIST.findIndex((p) => p.key === key);
}

/** Does this plan include this capability? Pure; the routes are what enforce. */
export function can(plan: PlanKey, capability: Capability): boolean {
  return rank(plan) >= rank(CAPABILITY_FLOOR[capability]);
}

/** Every capability this plan does NOT include — drives nav suppression. */
export function missingCapabilities(plan: PlanKey): Capability[] {
  return (Object.keys(CAPABILITY_FLOOR) as Capability[]).filter((c) => !can(plan, c));
}

/**
 * ⛔ FOUR BILLABLE TIERS. ONE OF THEM IS SMALLER, NONE OF THEM IS A DECOY.
 *
 * A one-truck shop was being asked for the same price as a ten-person crew.
 * Against roughly $245-500/mo for field software alone, that was a bad deal for
 * exactly the operator this product was built for. So the bottom rungs exist.
 *
 * ⛔ THE DOCTRINE CHANGED ON 2026-08-14, DELIBERATELY (Cory). This comment used
 * to read "Tiers sell seats. They never sell features," and `Plan` carried no
 * capability list, because gating capabilities is how a product becomes the
 * add-on ladder we attack ServiceTitan for. That reasoning was right about the
 * DANGER and wrong about the MECHANISM, so the rule was rewritten rather than
 * quietly dropped:
 *
 *   What we attack is DECEPTIVE UNBUNDLING — a quoted price that is not the
 *   price you pay, must-haves sold back as extras, upsell ads inside a product
 *   you already bought. Two clearly-published packages, each COMPLETE for the
 *   shop it is sold to, is not that. It is what Jobber and QuickBooks both do
 *   and nobody calls it a dark pattern.
 *
 * So the replacement rule, and it is the load-bearing one:
 *
 *   ⛔ LIGHT IS A COMPLETE PRODUCT FOR A ONE-PERSON SHOP, NEVER A CRIPPLED
 *   CREW. The fence is SCALE — crews, multi-user coordination, commercial and
 *   bonding work — and it is NEVER the money loop. Quoting, scheduling,
 *   invoicing, getting paid, the real double-entry books, job costing and job
 *   profit are on every tier including the cheapest. Nothing a solo operator
 *   needs on a normal Tuesday is withheld to manufacture an upgrade.
 *
 *   And there is still NO A-LA-CARTE STORE. You cannot buy a capability; you
 *   move up a rung, and every rung's contents are published. The price you see
 *   is the price you pay.
 *
 * The books in particular stay in Light on purpose: they are the entire reason
 * $99 beats Jobber's $49. Strip them and Light is an overpriced Jobber.
 *
 * ⛔ THE SOLO RUNG COVERS TWO PEOPLE, NOT ONE (Cory 2026-08-13, revised).
 * In this trade the second seat is almost always the owner's spouse doing the
 * books at the kitchen table. Charging a crew price the moment she gets a login
 * would price out the exact household the tier was created to protect. So the
 * cap is 2.
 *
 * ⛔ THE KEY IS "solo" AND THE NAME IS "Owner", ON PURPOSE. The key is an
 * identifier that is also baked into the live Stripe lookup_key
 * (`os_solo_349`, already created in test and live). Churning a live price's
 * lookup_key for a cosmetic rename buys nothing and risks a `price_not_found`
 * in production. The NAME is what a customer reads, and a husband-and-wife team
 * should not be told they are on "Solo". Do not "fix" this divergence.
 *
 * There is no plan above Shop because there is no fifth PRICE. Above 25 people
 * the answer is a conversation, and `checkSeat` says so in words. A plan with
 * no Stripe price would be a plan the billing system cannot charge — which is
 * also why `os_light_99` must exist in Stripe before Light is offered.
 *
 * PLAN_LIST is ordered cheapest first, and `checkSeat` relies on that ordering
 * to find "the next plan up" by scanning for a larger seatCap.
 */
export const PLANS: Record<PlanKey, Plan> = {
  light: {
    key: "light",
    name: "Light",
    priceCents: 9_900,
    seatCap: 1,
    lookupKey: "os_light_99",
    blurb:
      "Just you. Quotes, invoices, getting paid, and real books — without the crew tools you'd never open.",
  },
  solo: {
    key: "solo",
    name: "Owner",
    priceCents: 34_900,
    seatCap: 2,
    lookupKey: "os_solo_349",
    blurb: "You, or you and whoever does the books. The whole system, both jobs, one bill.",
  },
  crew: {
    key: "crew",
    name: "Crew",
    priceCents: 49_900,
    seatCap: 10,
    lookupKey: "os_crew_499",
    blurb: "Up to 10 people. Hiring someone never changes your bill.",
  },
  shop: {
    key: "shop",
    name: "Shop",
    priceCents: 99_900,
    seatCap: 25,
    lookupKey: "os_shop_999",
    blurb: "Up to 25 people, still one bill and still one set of books.",
  },
};

export const PLAN_LIST: Plan[] = [PLANS.light, PLANS.solo, PLANS.crew, PLANS.shop];

export function planFor(key: string): Plan {
  const p = PLANS[key as PlanKey];
  if (!p) throw new Error(`unknown_plan:${key}`);
  return p;
}

/** Upgrade = more seats. Drives proration behavior and the UI's wording. */
export function isUpgrade(from: PlanKey, to: PlanKey): boolean {
  return PLANS[to].seatCap > PLANS[from].seatCap;
}

export interface SeatCheck {
  allowed: boolean;
  seatCap: number;
  used: number;
  /** The plan that would fit, when the current one doesn't. */
  suggestPlan: PlanKey | null;
  message: string;
}

/**
 * Can this tenant add one more person? Plain-language answer either way —
 * a seat wall should read like a shop owner wrote it, not a paywall.
 */
/** ⛔ Counts here can be 1 (an Owner plan with one of its two seats filled),
 *  so they pluralise. "1 people" and "1 spots are open" is the kind of sentence
 *  that makes a shop owner trust the accounting less, which is not a trade
 *  worth making for one helper function. The seatCap === 1 branches below are
 *  kept deliberately: no plan has a cap of 1 today, and if one is ever added
 *  the wording should already be right rather than shipping "1 people". */
const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const spots = (n: number) => `${n} ${n === 1 ? "spot" : "spots"}`;

export function checkSeat(plan: PlanKey, currentMembers: number): SeatCheck {
  const { seatCap, name } = PLANS[plan];
  if (currentMembers < seatCap) {
    const open = seatCap - currentMembers;
    return {
      allowed: true,
      seatCap,
      used: currentMembers,
      suggestPlan: null,
      message: `${open} of your ${spots(seatCap)} ${open === 1 ? "is" : "are"} open.`,
    };
  }
  // PLAN_LIST is ordered cheapest first, so the first larger cap is the next
  // rung up, not an arbitrary bigger one.
  const bigger = PLAN_LIST.find((p) => p.seatCap > seatCap);
  const taken =
    seatCap === 1
      ? `Your ${name} plan covers just you, and that spot is taken.`
      : `Your ${name} plan covers ${people(seatCap)} and all ${seatCap} spots are taken.`;
  return {
    allowed: false,
    seatCap,
    used: currentMembers,
    suggestPlan: bigger?.key ?? null,
    message: bigger
      ? `${taken} Moving to ${bigger.name} ($${bigger.priceCents / 100}/mo) makes room for ${bigger.seatCap}.`
      : `${taken} Give us a call and we'll sort out a bigger plan.`,
  };
}

const money = (cents: number) =>
  `$${Math.floor(cents / 100).toLocaleString("en-US")}${cents % 100 ? `.${String(cents % 100).padStart(2, "0")}` : ""}`;

/** What the plan covers, said the way a person would, never "up to 1 people". */
const covers = (p: Plan) => (p.seatCap === 1 ? "just you" : `up to ${p.seatCap} people`);

/**
 * ⛔ "Everything included" is TRUE of every tier except Light, and saying it of
 * Light would be the exact dishonesty the tier doctrine forbids. Light gets a
 * claim that is complete rather than total.
 */
const scope = (p: Plan) =>
  p.key === "light" ? "everything a one-person shop runs on" : "everything included";

/** Plain-language state line for the billing screen. Figures verbatim. */
export function explainSubscription(s: {
  plan: PlanKey;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
}): string {
  const p = PLANS[s.plan];
  const when = (d: string | null) => (d ? d.slice(0, 10) : "soon");
  if (s.status === "canceled") {
    return `Your subscription is canceled. Your books are still yours — download everything any time from this page.`;
  }
  if (s.cancelAtPeriodEnd) {
    return `You're on ${p.name} (${money(p.priceCents)}/mo) and it ends ${when(s.currentPeriodEnd)}. Nothing more will be charged. Change your mind before then and one click brings it back.`;
  }
  if (s.status === "trialing") {
    return `You're on a free trial of ${p.name} through ${when(s.trialEndsAt)}, ${covers(p)}, ${scope(p)}. No card needed until you're ready.`;
  }
  if (s.status === "past_due") {
    return `The last payment didn't go through, so ${p.name} is past due. Update your card below and everything picks up where it left off — nothing has been deleted.`;
  }
  return `You're on ${p.name}: ${money(p.priceCents)} a month, ${covers(p)}, ${scope(p)}. Renews ${when(s.currentPeriodEnd)}.`;
}
