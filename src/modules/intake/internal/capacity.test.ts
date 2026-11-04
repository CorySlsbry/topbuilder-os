import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOWS,
  dayLoad,
  explainDayLoad,
  windowCapacity,
} from "./capacity";

/**
 * A stranger on the public booking page is being made a promise on the
 * strength of this arithmetic. It gets the same treatment as the money math.
 */

const win = (over: Partial<Parameters<typeof windowCapacity>[0]> = {}) =>
  windowCapacity({
    workerCount: 2,
    windowHours: 4,
    bookedMinutes: 0,
    jobMinutes: 120,
    ...over,
  });

describe("what is left in a window", () => {
  it("measures capacity as workers x window length, in minutes", () => {
    // 2 techs x 4 hours = 480 minutes, not "2 jobs".
    expect(win().capacityMinutes).toBe(480);
  });

  it("⛔ a big job and a small job do NOT consume the same capacity", () => {
    // This is the whole bug. Slot counting told a 3-tech shop it could take
    // three 8-hour changeouts before lunch.
    const afterSmall = win({ bookedMinutes: 60 });
    const afterBig = win({ bookedMinutes: 480 });
    expect(afterSmall.remainingMinutes).toBe(420);
    expect(afterBig.remainingMinutes).toBe(0);
  });

  it("only fits a job when the WHOLE job fits", () => {
    // Half a changeout is not a booking, it is an overrun discovered at 4pm.
    expect(win({ bookedMinutes: 400, jobMinutes: 120 }).fits).toBe(false);
    expect(win({ bookedMinutes: 360, jobMinutes: 120 }).fits).toBe(true);
  });

  it("⛔ a shop with NO active workers has no capacity", () => {
    // The old code wrote Math.max(1, workerCount), which promised a stranger
    // a slot at a shop that had deactivated everybody.
    const none = win({ workerCount: 0 });
    expect(none.capacityMinutes).toBe(0);
    expect(none.fits).toBe(false);
    expect(none.utilizationBps).toBe(0); // not NaN, not Infinity
  });

  it("reports an oversold window as negative remaining, not as zero", () => {
    // Clamping to zero hides the problem on the one screen that could fix it.
    const over = win({ bookedMinutes: 600 });
    expect(over.remainingMinutes).toBe(-120);
    expect(over.utilizationBps).toBe(12_500);
  });

  it("ignores nonsense input rather than propagating it", () => {
    expect(win({ bookedMinutes: -50 }).bookedMinutes).toBe(0);
    expect(win({ workerCount: -3 }).capacityMinutes).toBe(0);
  });
});

describe("the whole day", () => {
  const booked = (am: number, pm: number) =>
    new Map<"am" | "pm", number>([["am", am], ["pm", pm]]);

  it("adds both windows using the same arithmetic the booking page uses", () => {
    // 2 techs x (4h am + 4h pm) = 960 minutes.
    const d = dayLoad({ workerCount: 2, windows: DEFAULT_WINDOWS, bookedByWindow: booked(0, 0) });
    expect(d.capacityMinutes).toBe(960);
  });

  it("computes utilisation from real booked minutes", () => {
    const d = dayLoad({
      workerCount: 2,
      windows: DEFAULT_WINDOWS,
      bookedByWindow: booked(240, 240),
    });
    expect(d.bookedMinutes).toBe(480);
    expect(d.utilizationBps).toBe(5_000); // exactly half
    expect(d.oversold).toBe(false);
  });

  it("⛔ says OVERSOLD out loud rather than showing 100%", () => {
    const d = dayLoad({
      workerCount: 1,
      windows: DEFAULT_WINDOWS,
      bookedByWindow: booked(300, 300),
    });
    expect(d.oversold).toBe(true);
    expect(explainDayLoad(d)).toContain("oversold");
    expect(explainDayLoad(d)).toContain("run late");
  });

  it("handles a shop that works different hours", () => {
    // A roofer starting at 6 and finishing at 15 is not an edge case.
    const d = dayLoad({
      workerCount: 1,
      windows: [
        { key: "am", startHour: 6, endHour: 11 },
        { key: "pm", startHour: 12, endHour: 15 },
      ],
      bookedByWindow: booked(0, 0),
    });
    expect(d.capacityMinutes).toBe((5 + 3) * 60);
  });

  it("tells a dispatcher what to do, not a percentage", () => {
    const empty = dayLoad({
      workerCount: 2,
      windows: DEFAULT_WINDOWS,
      bookedByWindow: booked(0, 0),
    });
    expect(explainDayLoad(empty)).toContain("16 hours still open");

    const full = dayLoad({
      workerCount: 1,
      windows: DEFAULT_WINDOWS,
      bookedByWindow: booked(240, 240),
    });
    expect(explainDayLoad(full)).toContain("full");

    const nobody = dayLoad({
      workerCount: 0,
      windows: DEFAULT_WINDOWS,
      bookedByWindow: booked(0, 0),
    });
    expect(explainDayLoad(nobody)).toContain("no capacity");
  });
});
