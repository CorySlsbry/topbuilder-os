import { formatMoney } from "@/lib/money/cents";

/**
 * "NEEDS A DECISION THIS WEEK" — the top of every dashboard.
 *
 * ── WHY THIS IS THE MOST IMPORTANT CODE ON THE SCREEN ─────────────────────
 * A tile reading $147,942 is a fact somebody still has to interpret. The
 * sentence "Invoice $147,942 already earned on the Nguyen re-roof — never
 * billed" is a DECISION, and the difference is whether a contractor who
 * opens this at 5:40am with coffee actually does anything about it.
 *
 * ── THE RULES THESE FOLLOW ───────────────────────────────────────────────
 * 1. A name and a number in every sentence. "Some invoices are late" is
 *    noise; "$42,800 from Reyes Development, 42 days late" is an action.
 * 2. Ranked by MONEY AT STAKE, not by category. The owner reads three lines
 *    and stops, so the three most expensive things have to be the first
 *    three — not the three that happen to come from the first module.
 * 3. Every figure is passed IN, already computed by the deterministic
 *    layer. Nothing here does arithmetic on money beyond adding up what it
 *    was handed, and nothing here invents a number. Same discipline as the
 *    figure firewall: this file renders sentences, it does not do finance.
 * 4. Silence is a real answer. A shop with nothing wrong gets told so
 *    plainly rather than being handed five filler observations, because a
 *    list that always has five things on it teaches people to ignore it.
 */

export interface DecisionFacts {
  /** Work earned but never invoiced, per job. */
  underbilled: { jobId: string; jobNo: number; name: string; cents: number }[];
  /** Invoices past their due date. */
  lateInvoices: {
    invoiceId: string;
    invoiceNo: number;
    customerName: string;
    cents: number;
    daysLate: number;
  }[];
  /** Bills already late — a sub who is not paid stops showing up, and in
   *  most states can lien the job. */
  lateBills: { billId: string; vendorName: string; cents: number; daysLate: number }[];
  /** Retainage whose expected release date has passed. */
  overdueRetainage: {
    jobId: string;
    jobNo: number;
    name: string;
    cents: number;
    daysOverdue: number;
  }[];
  /** The lowest week in the cash plan, and the floor it is measured against. */
  cashLow: { weekLabel: string; cents: number; floorCents: number } | null;
  /** Open jobs projected to finish at a loss. */
  lossJobs: { jobId: string; jobNo: number; name: string; cents: number }[];
  /** Jobs whose estimate-to-complete has gone stale, so their percent
   *  complete is only as good as an old guess. */
  staleEtc: { jobId: string; jobNo: number; name: string; days: number }[];
  /** Bank lines waiting for an answer — the reconciliation blocker. */
  unansweredBankLines: number;
  /** Jobs marked complete that still have no invoice at all. */
  completedNotInvoiced: { jobId: string; jobNo: number; name: string }[];
}

export interface Decision {
  text: string;
  href?: string;
  urgent?: boolean;
  /** Money at stake, in cents — the ranking key. Zero for advisories. */
  weightCents: number;
}

const money = (cents: number) => `$${formatMoney(Math.abs(cents))}`;

export function buildDecisions(f: DecisionFacts, limit = 6): Decision[] {
  const out: Decision[] = [];

  // ── money already earned and simply not asked for ─────────────────────
  // First because it is the only item on this list that turns into cash
  // with no negotiation, no chasing and nobody else's cooperation.
  for (const j of f.underbilled) {
    out.push({
      text: `Invoice ${money(j.cents)} already earned on #${j.jobNo} ${j.name} — the work is done and it has never been billed.`,
      href: `/jobs/${j.jobId}`,
      urgent: true,
      weightCents: j.cents,
    });
  }

  // ── money owed to you, with a name on it ──────────────────────────────
  for (const inv of f.lateInvoices) {
    out.push({
      text: `Chase ${money(inv.cents)} from ${inv.customerName} — invoice #${inv.invoiceNo} is ${inv.daysLate} days past due.`,
      href: "/reports",
      urgent: inv.daysLate >= 30,
      weightCents: inv.cents,
    });
  }

  // ── retainage nobody released ─────────────────────────────────────────
  for (const r of f.overdueRetainage) {
    out.push({
      text: `${money(r.cents)} of retainage on #${r.jobNo} ${r.name} was due ${r.daysOverdue} days ago. Retainage does not chase itself.`,
      href: `/jobs/${r.jobId}`,
      urgent: r.daysOverdue > 60,
      weightCents: r.cents,
    });
  }

  // ── cash running out ──────────────────────────────────────────────────
  if (f.cashLow && f.cashLow.cents < f.cashLow.floorCents) {
    out.push({
      // Two sentences, because a floor of zero is not a floor anybody set.
      // Claiming "under the $0 you said you need to keep" would put words in
      // the owner's mouth; running out of money needs no such claim.
      text:
        f.cashLow.floorCents === 0
          ? `Cash runs out in ${f.cashLow.weekLabel} — down to ${money(f.cashLow.cents)}, counting only money that is already signed and scheduled. Bill something, or move a payment.`
          : `Cash falls to ${money(f.cashLow.cents)} in ${f.cashLow.weekLabel}, under the ${money(f.cashLow.floorCents)} you said you need to keep. Bill something, or move a payment.`,
      href: "/money",
      urgent: true,
      // Weighted by the SHORTFALL, not the balance — a $2k dip below the
      // floor should not outrank a $40k unbilled invoice.
      weightCents: f.cashLow.floorCents - f.cashLow.cents,
    });
  }

  // ── subs and suppliers you have not paid ──────────────────────────────
  for (const b of f.lateBills) {
    out.push({
      text: `${b.vendorName} is owed ${money(b.cents)}, ${b.daysLate} days late. A sub who is not paid stops showing up, and in most states can put a lien on the job.`,
      href: "/purchasing",
      urgent: b.daysLate >= 30,
      weightCents: b.cents,
    });
  }

  // ── jobs going backwards ──────────────────────────────────────────────
  for (const j of f.lossJobs) {
    out.push({
      text: `#${j.jobNo} ${j.name} is on track to lose ${money(j.cents)}. Re-price the rest of it, write a change order, or decide to eat it on purpose.`,
      href: `/jobs/${j.jobId}/money`,
      urgent: true,
      weightCents: j.cents,
    });
  }

  // ── finished work with no invoice at all ──────────────────────────────
  for (const j of f.completedNotInvoiced) {
    out.push({
      text: `#${j.jobNo} ${j.name} is marked finished and has no invoice on it at all.`,
      href: `/jobs/${j.jobId}`,
      urgent: true,
      // No dollar figure exists yet — that IS the problem. Ranked just under
      // the smallest real money item rather than pretending to a value.
      weightCents: 1,
    });
  }

  // ── advisories: no money at stake today, but they make the numbers
  //    above less trustworthy ───────────────────────────────────────────
  if (f.unansweredBankLines > 0) {
    out.push({
      text: `${f.unansweredBankLines} bank line${f.unansweredBankLines === 1 ? "" : "s"} still need${f.unansweredBankLines === 1 ? "s" : ""} an answer. Until they are cleared you cannot reconcile, and every number on this page is missing them.`,
      href: "/bank",
      weightCents: 0,
    });
  }
  for (const j of f.staleEtc) {
    out.push({
      text: `Nobody has updated the cost-to-finish on #${j.jobNo} ${j.name} in ${j.days} days, so its percent complete is only as good as that old guess.`,
      href: `/jobs/${j.jobId}/money`,
      weightCents: 0,
    });
  }

  // Money first, biggest first. Advisories keep their order behind it, so a
  // "you cannot reconcile" note never outranks an unbilled invoice.
  return out.sort((a, b) => b.weightCents - a.weightCents).slice(0, limit);
}

/**
 * What the page says when there is genuinely nothing to do.
 *
 * A list that always has five things on it teaches people to ignore it, so
 * an empty list has to read as an ACHIEVEMENT rather than as a broken query.
 */
export function nothingToDecide(f: DecisionFacts): string {
  if (f.unansweredBankLines > 0) {
    return "Nothing needs a decision — though there are still bank lines waiting for an answer, so this list is working from an incomplete picture.";
  }
  return "Nothing needs a decision this week. Everything earned is billed, nothing is badly late, and cash stays above your floor. That is what a good week looks like on paper.";
}
