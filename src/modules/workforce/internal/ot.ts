// Weekly overtime split — pure. Hours past the weekly threshold (default
// 40h, federal FLSA floor; per-state daily-OT regimes join the tenant tax
// profile later) become OT at 1.5×. Attribution is chronological: the
// hours that CROSS the threshold are the OT hours, entry by entry, so each
// job carries exactly the OT its calendar position caused.

export interface WeekEntry {
  id: string;
  workDate: string; // yyyy-mm-dd
  hoursX100: number; // hundredths of hours
}

export interface OtSplit {
  id: string;
  straightX100: number;
  otX100: number;
}

export const WEEKLY_OT_THRESHOLD_X100 = 40_00;

export function splitWeeklyOt(
  entries: WeekEntry[],
  thresholdX100 = WEEKLY_OT_THRESHOLD_X100,
): OtSplit[] {
  const sorted = [...entries].sort(
    (a, b) => a.workDate.localeCompare(b.workDate) || a.id.localeCompare(b.id),
  );
  let cumulative = 0;
  const out: OtSplit[] = [];
  for (const e of sorted) {
    if (!Number.isInteger(e.hoursX100) || e.hoursX100 < 0) {
      throw new Error(`invalid hours for entry ${e.id}`);
    }
    const before = cumulative;
    cumulative += e.hoursX100;
    const straight = Math.max(0, Math.min(e.hoursX100, thresholdX100 - before));
    out.push({ id: e.id, straightX100: straight, otX100: e.hoursX100 - straight });
  }
  return out;
}

/** Monday of the ISO week containing the date (construction pay weeks). */
export function weekStartOf(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${isoDate}`);
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}
