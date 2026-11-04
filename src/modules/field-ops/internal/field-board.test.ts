import { describe, expect, it } from "vitest";
import { buildFieldTasks, nothingToDo, type FieldFacts } from "./field-board";

/**
 * The field board, tested as a contract.
 *
 * Two things are being protected here. The obvious one is ordering — a list
 * that puts internal tidying above a waiting customer trains people to skim it.
 * The load-bearing one is that NO SHAPE IN THIS MODULE CAN CARRY A DOLLAR
 * AMOUNT, because the `field` wall exists to keep the ledger away from the
 * crew, and a screen that strips money in the browser has already sent it.
 */

const empty: FieldFacts = { today: [], staleAppointments: [], activeJobs: [], waitingIntake: [] };

const appt = (over: Partial<FieldFacts["today"][number]> = {}) => ({
  appointmentId: "a1",
  jobId: "j1",
  jobNo: 101,
  jobName: "Miller re-roof",
  customerName: "Dana Miller",
  startsAt: "2026-08-15T15:00:00.000Z",
  workerName: "Sal",
  status: "scheduled",
  ...over,
});

const job = (over: Partial<FieldFacts["activeJobs"][number]> = {}) => ({
  jobId: "j1",
  jobNo: 101,
  name: "Miller re-roof",
  customerName: "Dana Miller",
  status: "in-progress",
  hasCosts: true,
  openRequiredForms: 0,
  ageDays: 1,
  ...over,
});

const intake = (over: Partial<FieldFacts["waitingIntake"][number]> = {}) => ({
  intakeId: "i1",
  name: "Ruth Alvarez",
  description: "no cooling upstairs",
  createdAt: "2026-08-14T15:00:00.000Z",
  ageDays: 1,
  ...over,
});

describe("⛔ the field board cannot express money", () => {
  it("no task carries a cents field, however the facts are shaped", () => {
    const tasks = buildFieldTasks({
      today: [appt()],
      staleAppointments: [appt({ startsAt: "2026-08-10T15:00:00.000Z" })],
      activeJobs: [job({ hasCosts: false, ageDays: 9, openRequiredForms: 2 })],
      waitingIntake: [intake({ ageDays: 3 })],
    });
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(Object.keys(t).sort()).toEqual(["href", "text", "urgent", "weight"]);
      // And nothing formatted its way in through the prose either.
      expect(t.text).not.toMatch(/\$\s?\d/);
    }
  });
});

describe("ordering — a waiting customer outranks internal tidying", () => {
  it("puts an unanswered request first", () => {
    const tasks = buildFieldTasks({
      today: [],
      staleAppointments: [appt({ jobNo: 55, jobName: "Ortiz service" })],
      activeJobs: [job({ jobNo: 77, hasCosts: false, ageDays: 6 })],
      waitingIntake: [intake({ ageDays: 2 })],
    });
    expect(tasks[0]!.text).toContain("Ruth Alvarez");
    expect(tasks[0]!.urgent).toBe(true);
  });

  it("a request waiting longer outranks a newer one", () => {
    const tasks = buildFieldTasks({
      ...empty,
      waitingIntake: [
        intake({ intakeId: "new", name: "New Caller", ageDays: 0 }),
        intake({ intakeId: "old", name: "Old Caller", ageDays: 4 }),
      ],
    });
    expect(tasks[0]!.text).toContain("Old Caller");
  });

  it("blocked work outranks unrecorded work", () => {
    // A job that cannot be closed is stopping someone today; missing receipts
    // corrupt a number nobody is looking at yet.
    const tasks = buildFieldTasks({
      ...empty,
      activeJobs: [
        job({ jobId: "blocked", jobNo: 1, name: "Blocked", openRequiredForms: 1 }),
        job({ jobId: "silent", jobNo: 2, name: "Silent", hasCosts: false, ageDays: 20 }),
      ],
    });
    expect(tasks[0]!.text).toContain("Blocked");
    expect(tasks[1]!.text).toContain("Silent");
  });
});

describe("the no-costs nag has a grace period", () => {
  it("⛔ says nothing about a job booked today", () => {
    // A job with nothing on it yet is normal, not a problem. Nagging about it
    // is how a whole list gets ignored.
    const tasks = buildFieldTasks({ ...empty, activeJobs: [job({ hasCosts: false, ageDays: 0 })] });
    expect(tasks).toEqual([]);
  });

  it("speaks up once it has been going two days", () => {
    const tasks = buildFieldTasks({ ...empty, activeJobs: [job({ hasCosts: false, ageDays: 2 })] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.text).toContain("no materials or hours recorded");
  });

  it("stays quiet when costs ARE being captured, however old the job", () => {
    const tasks = buildFieldTasks({ ...empty, activeJobs: [job({ hasCosts: true, ageDays: 90 })] });
    expect(tasks).toEqual([]);
  });
});

describe("urgency is narrow on purpose", () => {
  it("only a customer waiting a day or more is urgent", () => {
    const same = buildFieldTasks({ ...empty, waitingIntake: [intake({ ageDays: 0 })] });
    expect(same[0]!.urgent).toBe(false);

    const day = buildFieldTasks({ ...empty, waitingIntake: [intake({ ageDays: 1 })] });
    expect(day[0]!.urgent).toBe(true);
  });

  it("internal housekeeping is never urgent", () => {
    // If everything is urgent, nothing is.
    const tasks = buildFieldTasks({
      ...empty,
      staleAppointments: [appt()],
      activeJobs: [job({ openRequiredForms: 3, hasCosts: false, ageDays: 30 })],
    });
    expect(tasks.every((t) => !t.urgent)).toBe(true);
  });
});

describe("the list is capped", () => {
  it("shows the top few, not everything", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      job({ jobId: `j${i}`, jobNo: i, hasCosts: false, ageDays: 5 }),
    );
    expect(buildFieldTasks({ ...empty, activeJobs: many })).toHaveLength(6);
    expect(buildFieldTasks({ ...empty, activeJobs: many }, 3)).toHaveLength(3);
  });
});

describe("nothingToDo", () => {
  it("mentions today's work when the list is clear but the board is not", () => {
    expect(nothingToDo({ ...empty, today: [appt(), appt({ appointmentId: "a2" })] })).toBe(
      "Nothing outstanding. 2 jobs on the board today.",
    );
  });

  it("singular reads like English", () => {
    expect(nothingToDo({ ...empty, today: [appt()] })).toContain("1 job on the board");
  });

  it("says so plainly when there is genuinely nothing", () => {
    expect(nothingToDo(empty)).toBe("Nothing outstanding, and nothing on the board today.");
  });
});

describe("⛔ stale appointments rank by NEGLECT, not by flat weight", () => {
  it("a long-forgotten appointment outranks yesterday's", () => {
    // Regression: these all carried a flat weight of 600, and the route pulled
    // them `ORDER BY ends_at DESC LIMIT 10` — newest first. Together that meant
    // the ten MOST RECENT stale appointments were kept and a six-week-old one
    // was discarded before the ranker ever saw it, so it could never surface
    // however long it sat. Found in review, 2026-08-15.
    const tasks = buildFieldTasks({
      ...empty,
      staleAppointments: [
        appt({ appointmentId: "fresh", jobNo: 1, jobName: "Yesterday", ageDays: 1 }),
        appt({ appointmentId: "old", jobNo: 2, jobName: "Six weeks", ageDays: 42 }),
      ],
    });
    expect(tasks[0]!.text).toContain("Six weeks");
    expect(tasks[1]!.text).toContain("Yesterday");
  });

  it("a missing ageDays does not throw or sort wildly", () => {
    const tasks = buildFieldTasks({ ...empty, staleAppointments: [appt({ ageDays: undefined })] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.weight).toBe(600);
  });

  it("⛔ neglect is capped so it never outranks a waiting customer", () => {
    // One appointment forgotten a year ago must not permanently own the top of
    // the list above somebody who called this morning.
    const tasks = buildFieldTasks({
      ...empty,
      staleAppointments: [appt({ jobName: "Ancient", ageDays: 4000 })],
      waitingIntake: [intake({ name: "Calling Now", ageDays: 0 })],
    });
    expect(tasks[0]!.text).toContain("Calling Now");
  });
});
