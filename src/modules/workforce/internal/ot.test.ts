import { describe, expect, it } from "vitest";
import { splitWeeklyOt, weekStartOf } from "./ot";

describe("splitWeeklyOt", () => {
  it("a normal week is all straight time", () => {
    const r = splitWeeklyOt([
      { id: "a", workDate: "2026-07-20", hoursX100: 8_00 },
      { id: "b", workDate: "2026-07-21", hoursX100: 8_00 },
    ]);
    expect(r).toEqual([
      { id: "a", straightX100: 8_00, otX100: 0 },
      { id: "b", straightX100: 8_00, otX100: 0 },
    ]);
  });
  it("the entry that crosses 40h splits exactly at the line", () => {
    const r = splitWeeklyOt([
      { id: "mon", workDate: "2026-07-20", hoursX100: 10_00 },
      { id: "tue", workDate: "2026-07-21", hoursX100: 10_00 },
      { id: "wed", workDate: "2026-07-22", hoursX100: 10_00 },
      { id: "thu", workDate: "2026-07-23", hoursX100: 10_00 },
      { id: "fri", workDate: "2026-07-24", hoursX100: 3_50 },
    ]);
    expect(r[3]).toEqual({ id: "thu", straightX100: 10_00, otX100: 0 });
    expect(r[4]).toEqual({ id: "fri", straightX100: 0, otX100: 3_50 });
  });
  it("mid-entry crossing attributes only the excess as OT", () => {
    const r = splitWeeklyOt([
      { id: "a", workDate: "2026-07-20", hoursX100: 38_00 },
      { id: "b", workDate: "2026-07-21", hoursX100: 6_25 },
    ]);
    expect(r[1]).toEqual({ id: "b", straightX100: 2_00, otX100: 4_25 });
  });
  it("chronological attribution is independent of input order", () => {
    const shuffled = splitWeeklyOt([
      { id: "b", workDate: "2026-07-21", hoursX100: 6_25 },
      { id: "a", workDate: "2026-07-20", hoursX100: 38_00 },
    ]);
    expect(shuffled.find((e) => e.id === "b")).toEqual({
      id: "b",
      straightX100: 2_00,
      otX100: 4_25,
    });
  });
  it("rejects garbage hours", () => {
    expect(() => splitWeeklyOt([{ id: "x", workDate: "2026-07-20", hoursX100: 1.5 }])).toThrow();
  });
});

describe("weekStartOf", () => {
  it("maps any day to its Monday", () => {
    expect(weekStartOf("2026-07-20")).toBe("2026-07-20"); // Mon
    expect(weekStartOf("2026-07-24")).toBe("2026-07-20"); // Fri
    expect(weekStartOf("2026-07-26")).toBe("2026-07-20"); // Sun
  });
  it("rejects garbage", () => {
    expect(() => weekStartOf("nope")).toThrow();
  });
});
