// What the FIELD side of a shop needs to look at this morning.
//
// PURE — no I/O, no server-only marker. Every input is an aggregate the route
// already fetched, so the ranking rules get tested in milliseconds and the
// interesting cases are assertions rather than a hope.
//
// ⛔ THERE IS NO MONEY IN THIS FILE, AND THAT IS THE DESIGN.
//
// The `field` department wall exists precisely so a tech or a dispatcher does
// not see the general ledger. The lazy way to build this screen would be to
// reuse the owner's dashboard and hide the dollar columns in the browser — and
// that is a disclosure bug wearing a stylesheet, because the ROUTE would still
// have returned the numbers and anyone can open the network tab. So the shapes
// below cannot express a dollar amount at all: there is no `cents` field to
// forget to strip, and `crewProfitView` already set this precedent by asserting
// forbidden keys are ABSENT rather than blanked.
//
// The consequence is a genuinely different screen, not a smaller one. The owner
// asks "what should I do about money"; the field asks "who is going where, and
// what did we forget to write down".

/** A job the field side is working, with no financial dimension at all. */
export interface FieldJob {
  jobId: string;
  jobNo: number;
  name: string;
  customerName: string;
  status: string;
  /** Has ANY cost been captured against it? Not how much — whether. */
  hasCosts: boolean;
  /** Required forms still unsigned. The thing that blocks marking complete. */
  openRequiredForms: number;
  /** Days since the job started, for staleness ranking. */
  ageDays: number;
}

/** One appointment on the board, times only. */
export interface FieldAppointment {
  appointmentId: string;
  jobId: string;
  jobNo: number;
  jobName: string;
  customerName: string;
  startsAt: string;
  workerName: string | null;
  status: string;
  /** Days since it ENDED. Only meaningful for a stale appointment; today's
   *  board has no age. Drives the ranking, so a long-neglected one outranks
   *  yesterday's — it used to be a flat weight, which meant it did not. */
  ageDays?: number;
}

/** A customer who asked for something and is still waiting. */
export interface FieldIntake {
  intakeId: string;
  name: string;
  description: string;
  createdAt: string;
  ageDays: number;
}

export interface FieldFacts {
  today: FieldAppointment[];
  /** Appointments whose time has passed and that nobody closed out. */
  staleAppointments: FieldAppointment[];
  activeJobs: FieldJob[];
  waitingIntake: FieldIntake[];
}

/**
 * One line telling somebody what to do, in their own vocabulary.
 *
 * `weight` ranks WITHOUT money — the operating dashboard sorts by dollars, and
 * this deliberately cannot. Higher is more urgent; the scale is arbitrary and
 * only ever compared against itself.
 */
export interface FieldTask {
  text: string;
  href: string;
  urgent: boolean;
  weight: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Build the "needs attention" list.
 *
 * Ordering is the argument, and it is not arbitrary. A customer waiting on an
 * answer outranks internal tidying, because they are the only item on this list
 * that is currently deciding whether to call somebody else. Then the things that
 * BLOCK work (a job that cannot be closed), then the things that quietly corrupt
 * the books later (work happening with nothing written down).
 */
export function buildFieldTasks(f: FieldFacts, limit = 6): FieldTask[] {
  const out: FieldTask[] = [];

  // ── somebody is waiting on us ────────────────────────────────────────────
  for (const i of f.waitingIntake) {
    out.push({
      text:
        i.ageDays >= 1
          ? `${i.name} asked about ${i.description || "work"} ${plural(i.ageDays, "day", "days")} ago and nobody has answered.`
          : `${i.name} just asked about ${i.description || "work"}.`,
      href: "/intake",
      // A day is a long time to a homeowner with water coming in.
      urgent: i.ageDays >= 1,
      weight: 1000 + i.ageDays * 50,
    });
  }

  // ── the board says work happened and nobody said how it went ─────────────
  // Left open, an appointment tells the dispatcher a truck is still out and
  // tells the customer nothing.
  for (const a of f.staleAppointments) {
    const age = a.ageDays ?? 0;
    out.push({
      text: `#${a.jobNo} ${a.jobName} was scheduled for ${a.startsAt.slice(0, 10)} and is still open — mark it done or move it.`,
      href: `/jobs/${a.jobId}`,
      urgent: false,
      // Weighted by neglect, capped so one forgotten appointment from last year
      // cannot permanently own the top of the list above a customer waiting now.
      weight: 600 + Math.min(age, 30),
    });
  }

  // ── a job that cannot be finished ────────────────────────────────────────
  for (const j of f.activeJobs.filter((j) => j.openRequiredForms > 0)) {
    out.push({
      text: `#${j.jobNo} ${j.name} needs ${plural(j.openRequiredForms, "form", "forms")} signed before it can be marked complete.`,
      href: `/jobs/${j.jobId}`,
      urgent: false,
      weight: 500 + j.openRequiredForms,
    });
  }

  // ── work with nothing written down ───────────────────────────────────────
  // ⛔ This is the one that looks like bookkeeping and is not. Every hour and
  // every receipt that never gets captured makes the job's profit wrong LATER,
  // by which time nobody remembers what was bought. The threshold is 2 days
  // because a job booked this morning legitimately has nothing on it yet, and a
  // list that nags about that gets ignored wholesale.
  for (const j of f.activeJobs.filter((j) => !j.hasCosts && j.ageDays >= 2)) {
    out.push({
      text: `#${j.jobNo} ${j.name} has been going ${plural(j.ageDays, "day", "days")} with no materials or hours recorded.`,
      href: `/jobs/${j.jobId}`,
      urgent: false,
      weight: 300 + Math.min(j.ageDays, 30),
    });
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, limit);
}

/**
 * What the screen says when the list is empty.
 *
 * A blank panel reads as broken. It has to say the shop is clear, and it must
 * only say so when that is TRUE of everything the list checks — an "all clear"
 * that ignores a category is worse than no message.
 */
export function nothingToDo(f: FieldFacts): string {
  if (f.today.length > 0) {
    return `Nothing outstanding. ${plural(f.today.length, "job", "jobs")} on the board today.`;
  }
  return "Nothing outstanding, and nothing on the board today.";
}
