import { describe, expect, it } from "vitest";
import {
  computeOpenSlots,
  localDate,
  localWindow,
  partsIn,
  pickSlot,
  zonedTimeToUtc,
} from "./slots";

/**
 * These are the tests that make online self-booking safe to build.
 *
 * Every window used to be emitted at 08:00Z / 13:00Z with weekends detected by
 * getUTCDay(), so a Phoenix shop's "morning" was 1am local. That survived only
 * because a human always read the time back and corrected it mentally. A
 * customer picking their own slot cannot, so the arithmetic has to be right.
 *
 * PHX = America/Phoenix — the demo shop, and useful because Arizona does NOT
 * observe DST, so it is a fixed -07:00 and any drift is arithmetic, not tz.
 * NYC = America/New_York — the DST case, which is where naive implementations
 * (fixed offsets, server-local Date parsing) break twice a year.
 */
const PHX = "America/Phoenix";
const NYC = "America/New_York";

describe("zonedTimeToUtc", () => {
  it("Phoenix 8am is 15:00Z, all year (no DST)", () => {
    expect(zonedTimeToUtc("2026-01-15", 8, 0, PHX).toISOString()).toBe("2026-01-15T15:00:00.000Z");
    expect(zonedTimeToUtc("2026-07-15", 8, 0, PHX).toISOString()).toBe("2026-07-15T15:00:00.000Z");
  });

  it("New York 8am shifts with DST — the whole reason this is not an offset", () => {
    // EST (UTC-5) in January, EDT (UTC-4) in July.
    expect(zonedTimeToUtc("2026-01-15", 8, 0, NYC).toISOString()).toBe("2026-01-15T13:00:00.000Z");
    expect(zonedTimeToUtc("2026-07-15", 8, 0, NYC).toISOString()).toBe("2026-07-15T12:00:00.000Z");
  });

  it("lands on the right instant across a spring-forward boundary", () => {
    // 2026-03-08 is the US spring-forward. 8am that morning is already EDT.
    expect(zonedTimeToUtc("2026-03-08", 8, 0, NYC).toISOString()).toBe("2026-03-08T12:00:00.000Z");
    // The day before is still EST.
    expect(zonedTimeToUtc("2026-03-07", 8, 0, NYC).toISOString()).toBe("2026-03-07T13:00:00.000Z");
  });

  it("round-trips: the instant reads back as the wall clock we asked for", () => {
    for (const [zone, date] of [
      [PHX, "2026-08-11"],
      [NYC, "2026-11-01"], // fall-back day
      [NYC, "2026-03-08"], // spring-forward day
      ["Europe/London", "2026-03-29"],
    ] as const) {
      const utc = zonedTimeToUtc(date, 13, 0, zone);
      const p = partsIn(utc, zone);
      expect(`${p.hour}:${p.minute}`, `${zone} ${date}`).toBe("13:0");
      expect(localDate(utc, zone), `${zone} ${date}`).toBe(date);
    }
  });
});

describe("localDate / localWindow — bucketing an existing appointment", () => {
  it("an instant late in the UTC day is still the PREVIOUS day in Phoenix", () => {
    // 03:00Z on the 12th is 20:00 on the 11th in Phoenix. Bucketing this as
    // the 12th is exactly how a booked slot goes missing from the count.
    const late = new Date("2026-08-12T03:00:00Z");
    expect(localDate(late, PHX)).toBe("2026-08-11");
    expect(localWindow(late, PHX)).toBe("pm");
  });

  it("the old UTC bucketing would have called Phoenix 8am 'pm'", () => {
    const morning = new Date("2026-08-11T15:00:00.000Z"); // 8am PHX
    expect(localWindow(morning, PHX)).toBe("am");
    // …while the hour in UTC is 15, which the previous implementation read as
    // the afternoon window. This assertion is the bug, pinned.
    expect(morning.getUTCHours()).toBe(15);
  });
});

describe("computeOpenSlots", () => {
  const base = { workerCount: 2, bookedByWindow: new Map<string, number>(), timeZone: PHX };

  it("skips weekends and offers two windows per day", () => {
    // 2026-07-24 is a Friday; the next business days are Mon 27, Tue 28.
    const slots = computeOpenSlots({ ...base, fromDate: "2026-07-24", days: 2 });
    expect(slots.map((s) => `${s.date} ${s.window}`)).toEqual([
      "2026-07-27 am",
      "2026-07-27 pm",
      "2026-07-28 am",
      "2026-07-28 pm",
    ]);
    // `remaining` is now how many more jobs OF THIS SIZE fit — the only
    // reading that survives jobs having different lengths. Two techs x a
    // 4-hour morning is 480 minutes; at the default 2-hour job that is 4,
    // not "2 because there are 2 techs".
    expect(slots[0]!.remainingMinutes).toBe(480);
    expect(slots[0]!.remaining).toBe(4);
  });

  it("emits instants in the SHOP'S clock, not UTC", () => {
    const [am, pm] = computeOpenSlots({ ...base, fromDate: "2026-07-24", days: 1 });
    expect(am!.startsAt).toBe("2026-07-27T15:00:00.000Z"); // 8am Phoenix
    expect(am!.endsAt).toBe("2026-07-27T19:00:00.000Z"); // noon Phoenix
    expect(pm!.startsAt).toBe("2026-07-27T20:00:00.000Z"); // 1pm Phoenix
  });

  it("labels the window in plain local time for the customer", () => {
    const [am, pm] = computeOpenSlots({ ...base, fromDate: "2026-07-24", days: 1 });
    expect(am!.label).toBe("8:00 AM–12:00 PM");
    expect(pm!.label).toBe("1:00 PM–5:00 PM");
  });

  it("the same calendar day in a DST zone still starts at 8am local", () => {
    const slots = computeOpenSlots({
      ...base,
      timeZone: NYC,
      fromDate: "2026-03-06", // Friday; Monday the 9th is after spring-forward
      days: 1,
    });
    expect(slots[0]!.date).toBe("2026-03-09");
    expect(slots[0]!.startsAt).toBe("2026-03-09T12:00:00.000Z"); // 8am EDT
  });

  it("a full window disappears — only REAL capacity is offered", () => {
    // bookedByWindow is MINUTES now, not a count of appointments. One tech
    // for a 4-hour morning is 240 minutes; 240 booked leaves nothing.
    const slots = computeOpenSlots({
      ...base,
      workerCount: 1,
      fromDate: "2026-07-24",
      days: 1,
      bookedByWindow: new Map([["2026-07-27|am", 240]]),
    });
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ date: "2026-07-27", window: "pm" });
  });

  it("⛔ a LONG job does not fit where a short one would", () => {
    // The bug this replaced: slot counting let a 3-tech shop take three
    // 8-hour changeouts before lunch, because job length was not a concept.
    // One tech, 4-hour morning, 3 hours already booked = 60 minutes left.
    const args = {
      ...base,
      workerCount: 1,
      fromDate: "2026-07-24",
      days: 1,
      bookedByWindow: new Map([["2026-07-27|am", 180]]),
    };
    const short = computeOpenSlots({ ...args, jobMinutes: 60 });
    const long = computeOpenSlots({ ...args, jobMinutes: 120 });
    expect(short.some((s) => s.window === "am")).toBe(true);
    expect(long.some((s) => s.window === "am")).toBe(false);
  });

  it("⛔ zero workers means NO capacity, not one", () => {
    // This used to be `Math.max(1, workerCount)`, which promised a stranger a
    // slot at a shop that had deactivated everybody. Whether a zero means
    // "solo owner" or "shop closed" is a question the CALLER can answer and
    // this function cannot — see effectiveWorkerCount in public-booking.ts.
    const slots = computeOpenSlots({ ...base, workerCount: 0, fromDate: "2026-07-24", days: 1 });
    expect(slots).toEqual([]);
  });

  it("never offers today", () => {
    const slots = computeOpenSlots({ ...base, fromDate: "2026-07-27", days: 1 });
    expect(slots.every((s) => s.date > "2026-07-27")).toBe(true);
  });

  it("rejects a malformed date rather than silently producing garbage", () => {
    expect(() => computeOpenSlots({ ...base, fromDate: "nope", days: 1 })).toThrow(/invalid date/);
  });

  it("is bounded — a huge horizon terminates", () => {
    const slots = computeOpenSlots({ ...base, fromDate: "2026-07-24", days: 5000 });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThan(2000);
  });
});

describe("pickSlot", () => {
  const slots = computeOpenSlots({
    fromDate: "2026-07-24",
    days: 2,
    workerCount: 1,
    bookedByWindow: new Map(),
    timeZone: PHX,
  });

  it("honors a preference", () => {
    expect(pickSlot(slots, "afternoon")).toMatchObject({ date: "2026-07-27", window: "pm" });
  });
  it("falls back to the earliest when the preference can't be met", () => {
    expect(pickSlot(slots.filter((s) => s.window === "am"), "afternoon")).toMatchObject({
      window: "am",
    });
  });
  it("empty -> null", () => {
    expect(pickSlot([], "any")).toBeNull();
  });
});
