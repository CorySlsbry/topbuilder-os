// Open-slot computation — pure, deterministic, and now aware of what clock the
// shop actually runs on.
//
// Two windows per business day (morning 08:00–12:00, afternoon 13:00–17:00)
// IN THE SHOP'S TIMEZONE. Capacity per window = active workers (min 1). A slot
// is offered ONLY if real capacity remains — the Receptionist never promises a
// time the crew can't make.
//
// ⛔ This file used to hardcode UTC: it emitted "08:00Z", detected weekends
// with getUTCDay(), and its caller bucketed appointments with
// `AT TIME ZONE 'UTC'`. For a Phoenix shop that made "morning" 1am local. It
// survived because a human always read the time back on a screen and corrected
// it in their head — which stops being true the moment a CUSTOMER picks the
// slot. See migration 0042.
//
// Still pure: the zone is an argument, not a lookup. Everything here is
// testable without a database, a server, or the machine's own locale.
//
// ⛔ CAPACITY IS MINUTES, NOT A COUNT OF JOBS — see ./capacity.ts. Counting
// slots told a three-tech shop it could take three eight-hour changeouts
// before lunch, because a capacitor swap consumed the same capacity as a
// system replacement.

import { windowCapacity, type WorkWindow } from "./capacity";

export interface SlotInput {
  /** ISO date to start from, in the SHOP'S timezone. */
  fromDate: string;
  days: number;
  workerCount: number;
  /** Booked appointment counts per "date|window" key (window: am|pm), already
   *  bucketed in the shop's timezone by the caller. */
  bookedByWindow: Map<string, number>;
  /** How long the job being booked takes. Defaults to two hours. */
  jobMinutes?: number;
  /** The shop's working windows. Defaults to 08-12 and 13-17. */
  windows?: WorkWindow[];
  /** IANA zone, e.g. "America/Phoenix". */
  timeZone: string;
}

export interface OpenSlot {
  /** Local calendar date in the shop's zone. */
  date: string;
  window: "am" | "pm";
  /** ISO INSTANT (UTC) of the window's start — what gets stored. */
  startsAt: string;
  endsAt: string;
  remaining: number;
  /** Minutes left in the window — the honest figure behind `remaining`. */
  remainingMinutes: number;
  /** "8:00 AM" in the shop's zone — what a customer is shown. Computed here so
   *  no caller has to re-derive it and get the zone wrong. */
  label: string;
}

const WINDOWS: { key: "am" | "pm"; startHour: number; endHour: number }[] = [
  { key: "am", startHour: 8, endHour: 12 },
  { key: "pm", startHour: 13, endHour: 17 },
];

/**
 * The UTC instant for a wall-clock time in a given zone.
 *
 * There is no built-in for this, and the naive approaches are all wrong:
 * `new Date("2026-08-11T08:00:00")` uses the SERVER's zone (Cloud Run is UTC,
 * a laptop is not — so it is environment-dependent, which is the worst kind of
 * date bug). Adding a fixed offset breaks twice a year on DST.
 *
 * This inverts the problem instead: format a candidate instant IN the target
 * zone, measure how far off the wall clock is, and correct. One iteration is
 * enough everywhere except the ambiguous hour at a DST transition, so it runs
 * twice — the second pass converges on the fold. No dependency; Intl is the
 * tz database that ships with the runtime.
 */
export function zonedTimeToUtc(
  date: string,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    hour,
    minute,
  );
  let guess = target;
  for (let i = 0; i < 2; i++) {
    guess = target + (guess - wallClockUtc(new Date(guess), timeZone));
  }
  return new Date(guess);
}

/** What a UTC instant reads as on the wall clock in `timeZone`, expressed
 *  back as a UTC epoch so the two are subtractable. */
function wallClockUtc(instant: Date, timeZone: string): number {
  const p = partsIn(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Calendar fields of an instant as read in `timeZone`. */
export function partsIn(instant: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const got: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) got[part.type] = part.value;
  return {
    year: Number(got.year),
    month: Number(got.month),
    day: Number(got.day),
    // Intl renders midnight as "24" in some engines; normalise it.
    hour: Number(got.hour) % 24,
    minute: Number(got.minute),
    second: Number(got.second),
    weekday: WEEKDAYS.indexOf(got.weekday ?? "Sun"),
  };
}

/** "2026-08-11" as read in `timeZone` — the shop's idea of "today". */
export function localDate(instant: Date, timeZone: string): string {
  const p = partsIn(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Which half-day an instant falls in, on the shop's clock. */
export function localWindow(instant: Date, timeZone: string): "am" | "pm" {
  return partsIn(instant, timeZone).hour < 12 ? "am" : "pm";
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function hour12(h: number): string {
  const suffix = h < 12 ? "AM" : "PM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${suffix}`;
}

export function computeOpenSlots(input: SlotInput): OpenSlot[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fromDate)) {
    throw new Error(`invalid date: ${input.fromDate}`);
  }
  // ⛔ NOT Math.max(1, workerCount). That promised a stranger a slot at a
  // shop that had deactivated everybody — the one case where "be generous"
  // books a visit nobody can attend.
  const workers = Math.max(0, Math.trunc(input.workerCount));
  // How long the job being booked will take. Self-bookings have no job yet,
  // so the shop's own default is the only honest number available.
  const jobMinutes = Math.max(1, input.jobMinutes ?? 120);
  const windows = input.windows ?? WINDOWS;
  const out: OpenSlot[] = [];
  let cursor = input.fromDate;
  let seen = 0;
  // Bounded independently of `days` so a caller asking for 400 business days
  // cannot spin: two years of calendar is far past any booking horizon.
  let guard = 0;

  while (seen < input.days && guard++ < 800) {
    // Tomorrow onward. Today is deliberately not offered — a slot the crew is
    // already driving to is not open, and "book me for this morning" at 11:45
    // is a phone call, not a form.
    cursor = addDays(cursor, 1);

    const noon = zonedTimeToUtc(cursor, 12, 0, input.timeZone);
    const dow = partsIn(noon, input.timeZone).weekday;
    if (dow === 0 || dow === 6) continue; // weekends off
    seen++;

    for (const w of windows) {
      // ⛔ MINUTES, not a count of jobs. Slot counting told a three-tech shop
      // it could take three eight-hour changeouts before lunch, because a
      // capacitor swap and a system replacement consumed identical capacity.
      // `bookedByWindow` now carries the real span of every appointment.
      const cap = windowCapacity({
        workerCount: workers,
        windowHours: w.endHour - w.startHour,
        bookedMinutes: input.bookedByWindow.get(`${cursor}|${w.key}`) ?? 0,
        jobMinutes,
      });
      if (cap.fits) {
        out.push({
          date: cursor,
          window: w.key,
          startsAt: zonedTimeToUtc(cursor, w.startHour, 0, input.timeZone).toISOString(),
          endsAt: zonedTimeToUtc(cursor, w.endHour, 0, input.timeZone).toISOString(),
          // How many more jobs OF THIS SIZE fit — the only reading of
          // "remaining" that survives jobs having different lengths.
          remaining: Math.floor(cap.remainingMinutes / jobMinutes),
          remainingMinutes: cap.remainingMinutes,
          label: `${hour12(w.startHour)}–${hour12(w.endHour)}`,
        });
      }
    }
  }
  return out;
}

/** Earliest open slot honoring the caller's preference (falls back to any). */
export function pickSlot(
  slots: OpenSlot[],
  preferred: "any" | "morning" | "afternoon",
): OpenSlot | null {
  const want = preferred === "morning" ? "am" : preferred === "afternoon" ? "pm" : null;
  if (want) {
    const hit = slots.find((s) => s.window === want);
    if (hit) return hit;
  }
  return slots[0] ?? null;
}
