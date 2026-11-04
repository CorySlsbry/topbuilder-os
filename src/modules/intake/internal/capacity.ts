/**
 * ⛔ ONE DEFINITION OF CAPACITY, AND IT IS MEASURED IN MINUTES.
 *
 * There were three, and the public self-booking page was promising strangers
 * times against one of them:
 *
 *   1. `/dispatch` computed `workers.length * 2` in the browser.
 *   2. `computeOpenSlots` computed `max(1, activeWorkers)` jobs per half-day
 *      window on the server.
 *   3. The commit-time re-count in `publicSelfBook` used the same formula but
 *      counted booked appointments WITHOUT the `starts_at > now()` filter the
 *      offer query applies — so a window containing a past appointment looked
 *      fuller at commit than at offer, and the stranger who did everything
 *      right got "that slot was just taken".
 *
 * None of them knew how long a job takes. A one-hour capacitor swap and an
 * eight-hour changeout consumed identical capacity, so a shop with three
 * techs was told it could take three changeouts before lunch.
 *
 * ── WHY MINUTES ARE AVAILABLE AND SLOTS WERE A CHOICE ────────────────────
 * `appointments` has carried `starts_at` and `ends_at` since day one. The
 * booked side of the equation was always measurable in minutes; it was
 * simply never read that way. The only genuinely unknown quantity is how
 * long the NEXT job will take — which is why `jobs.estimated_minutes` and a
 * per-shop `default_job_minutes` exist (migration 0056), and why this
 * function takes the duration as an argument rather than guessing.
 *
 * Pure, integer minutes, deterministic. Same rules as the money layer, for
 * the same reason: a stranger is being made a promise on the strength of it.
 */

/**
 * A block of the working day. Named WorkWindow rather than Window because
 * `Window` is a DOM global — a shadowed built-in type resolves to whichever
 * one the file happens to see, and the error it produces names both.
 */
export interface WorkWindow {
  key: "am" | "pm";
  startHour: number;
  endHour: number;
}

export const DEFAULT_WINDOWS: WorkWindow[] = [
  { key: "am", startHour: 8, endHour: 12 },
  { key: "pm", startHour: 13, endHour: 17 },
];

export interface WindowCapacityInput {
  /** Techs available to work. */
  workerCount: number;
  /** The window's length in hours. */
  windowHours: number;
  /** Minutes already committed in this window, from real appointment spans. */
  bookedMinutes: number;
  /** How long the job being considered will take. */
  jobMinutes: number;
}

export interface WindowCapacity {
  capacityMinutes: number;
  bookedMinutes: number;
  remainingMinutes: number;
  /** Does the job being considered actually fit? */
  fits: boolean;
  /** 0..10000. Over 10000 means the window is oversold. */
  utilizationBps: number;
}

/**
 * What is left in one window.
 *
 * ⛔ A SHOP WITH NO ACTIVE WORKERS HAS NO CAPACITY. The old code wrote
 * `Math.max(1, workerCount)`, which quietly promised a stranger a slot at a
 * shop that had deactivated everybody. A shop with nobody on the books
 * should show no availability, and the booking page should say the shop is
 * not taking online bookings — not book a visit nobody can attend.
 */
export function windowCapacity(input: WindowCapacityInput): WindowCapacity {
  const workers = Math.max(0, Math.trunc(input.workerCount));
  const windowMinutes = Math.max(0, Math.round(input.windowHours * 60));
  const capacityMinutes = workers * windowMinutes;
  const booked = Math.max(0, Math.trunc(input.bookedMinutes));
  const remaining = capacityMinutes - booked;

  return {
    capacityMinutes,
    bookedMinutes: booked,
    remainingMinutes: remaining,
    // A job fits only if the whole of it fits. Half a changeout is not a
    // booking, it is an overrun somebody discovers at 4pm.
    fits: capacityMinutes > 0 && remaining >= Math.max(1, input.jobMinutes),
    utilizationBps:
      capacityMinutes === 0 ? 0 : Math.round((booked / capacityMinutes) * 10_000),
  };
}

export interface DayLoadInput {
  workerCount: number;
  windows: WorkWindow[];
  /** Minutes booked, keyed by window. */
  bookedByWindow: Map<"am" | "pm", number>;
}

export interface DayLoad {
  capacityMinutes: number;
  bookedMinutes: number;
  remainingMinutes: number;
  utilizationBps: number;
  /** True when more is booked than can be worked — the number a dispatch
   *  board has to show in words, because it is already too late to prevent. */
  oversold: boolean;
}

/** The whole day, for the dispatch board — the same arithmetic the public
 *  booking page uses, so the office and the website cannot disagree. */
export function dayLoad(input: DayLoadInput): DayLoad {
  let capacityMinutes = 0;
  let bookedMinutes = 0;
  for (const w of input.windows) {
    const c = windowCapacity({
      workerCount: input.workerCount,
      windowHours: Math.max(0, w.endHour - w.startHour),
      bookedMinutes: input.bookedByWindow.get(w.key) ?? 0,
      jobMinutes: 1,
    });
    capacityMinutes += c.capacityMinutes;
    bookedMinutes += c.bookedMinutes;
  }
  const remaining = capacityMinutes - bookedMinutes;
  return {
    capacityMinutes,
    bookedMinutes,
    remainingMinutes: remaining,
    utilizationBps:
      capacityMinutes === 0 ? 0 : Math.round((bookedMinutes / capacityMinutes) * 10_000),
    oversold: remaining < 0,
  };
}

/** Plain-English, because "62%" is not what a dispatcher needs to hear. */
export function explainDayLoad(load: DayLoad): string {
  if (load.capacityMinutes === 0) {
    return "Nobody is active on the schedule, so there is no capacity at all today.";
  }
  if (load.oversold) {
    const over = Math.round(-load.remainingMinutes / 60);
    return `This day is oversold by about ${over} hour${over === 1 ? "" : "s"}. Something will run late or move.`;
  }
  const hours = Math.round(load.remainingMinutes / 60);
  if (hours === 0) {
    return "This day is full. Anything else goes to the next open day.";
  }
  return `About ${hours} hour${hours === 1 ? "" : "s"} still open today.`;
}
