import { describe, expect, it } from "vitest";
import {
  completeness,
  explainCompleteness,
  isAnswered,
  jobCompletionGate,
  type FormItemAnswer,
} from "./completeness";

const item = (over: Partial<FormItemAnswer>): FormItemAnswer => ({
  kind: "check",
  label: "Item",
  required: true,
  ...over,
});

describe("isAnswered — the subtle cases are the whole point", () => {
  it("⛔ an unticked box is NOT an answer of 'no'", () => {
    // It is the absence of an answer. A shop that genuinely means "no" needs a
    // text or number item — treating false as done is how a safety form gets
    // signed off by nobody looking at it.
    expect(isAnswered(item({ kind: "check", checked: true }))).toBe(true);
    expect(isAnswered(item({ kind: "check", checked: false }))).toBe(false);
    expect(isAnswered(item({ kind: "check", checked: null }))).toBe(false);
    expect(isAnswered(item({ kind: "check" }))).toBe(false);
  });

  it("⛔ ZERO is a real answer for a number", () => {
    // `!value` would reject it, and "0 leaks found" is exactly the answer a
    // safety checklist is asking for.
    expect(isAnswered(item({ kind: "number", valueNumber: 0 }))).toBe(true);
    expect(isAnswered(item({ kind: "number", valueNumber: 45.5 }))).toBe(true);
    expect(isAnswered(item({ kind: "number", valueNumber: null }))).toBe(false);
    expect(isAnswered(item({ kind: "number" }))).toBe(false);
  });

  it("whitespace is not text", () => {
    expect(isAnswered(item({ kind: "text", valueText: "ok" }))).toBe(true);
    expect(isAnswered(item({ kind: "text", valueText: "   " }))).toBe(false);
    expect(isAnswered(item({ kind: "text", valueText: "" }))).toBe(false);
  });

  it("a photo needs an actual attachment", () => {
    expect(isAnswered(item({ kind: "photo", attachmentId: "att-1" }))).toBe(true);
    expect(isAnswered(item({ kind: "photo", attachmentId: null }))).toBe(false);
  });

  it("⛔ a signature accepts a DRAWN image OR a typed name", () => {
    // Requiring a drawn squiggle makes a motor path the only way to finish a
    // job. Some hands and some gloves cannot produce one, and the person
    // holding the phone is not the one who chose the form.
    expect(isAnswered(item({ kind: "signature", attachmentId: "att-1" }))).toBe(true);
    expect(isAnswered(item({ kind: "signature", signedName: "Dana Rivera" }))).toBe(true);
    expect(isAnswered(item({ kind: "signature", signedName: "  " }))).toBe(false);
    expect(isAnswered(item({ kind: "signature" }))).toBe(false);
  });
});

describe("completeness", () => {
  const form: FormItemAnswer[] = [
    item({ kind: "check", label: "Power off at breaker", checked: true }),
    item({ kind: "number", label: "Torque check", valueNumber: null }),
    item({ kind: "text", label: "Notes", required: false, valueText: "" }),
    item({ kind: "signature", label: "Customer signature" }),
  ];

  it("only REQUIRED items block", () => {
    const c = completeness(form);
    expect(c.total).toBe(4);
    expect(c.requiredTotal).toBe(3);
    expect(c.canComplete).toBe(false);
    expect(c.missing).toEqual(["Torque check", "Customer signature"]);
  });

  it("an optional item left blank never stands in the way", () => {
    const done = form.map((i) =>
      i.label === "Torque check"
        ? { ...i, valueNumber: 45 }
        : i.label === "Customer signature"
          ? { ...i, signedName: "Dana" }
          : i,
    );
    const c = completeness(done);
    expect(c.canComplete).toBe(true);
    expect(c.answered).toBe(3); // Notes still blank, and that is fine
  });

  it("⛔ NAMES what is missing instead of saying 'incomplete'", () => {
    // "This form is incomplete" is the message that makes somebody hunt
    // through twenty rows on a phone in the sun.
    const text = explainCompleteness(completeness(form));
    expect(text).toContain("Torque check");
    expect(text).toContain("Customer signature");
    expect(text).not.toMatch(/^This form is incomplete\.?$/);
  });

  it("says so plainly when nothing is required at all", () => {
    const c = completeness([item({ required: false, checked: true })]);
    expect(c.canComplete).toBe(true);
    expect(explainCompleteness(c)).toContain("Nothing on this form is required");
  });

  it("stops listing after four and counts the rest", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map((l) => item({ label: l }));
    expect(explainCompleteness(completeness(many))).toContain("and 2 more");
  });
});

describe("⛔ the job completion gate", () => {
  const forms = [
    { formId: "f1", name: "Safety sign-off", requiredForCompletion: true, status: "open" as const },
    { formId: "f2", name: "Photo log", requiredForCompletion: false, status: "open" as const },
  ];

  it("is INERT until the tenant switches it on", () => {
    // It ships off. A rule that can strand a crew at 6pm on a Friday does not
    // arrive because we shipped it.
    const g = jobCompletionGate(false, forms);
    expect(g.blocked).toBe(false);
    expect(g.explain).toBe("");
  });

  it("blocks on a required form, and names it", () => {
    const g = jobCompletionGate(true, forms);
    expect(g.blocked).toBe(true);
    expect(g.blockedBy).toEqual(["Safety sign-off"]);
    // A crew member hitting this should know instantly whether to finish the
    // form or call the office, rather than concluding the software is broken.
    expect(g.explain).toContain("Safety sign-off");
    expect(g.explain).toContain("owner or admin can turn this requirement off");
  });

  it("a form that is NOT required-for-completion never blocks", () => {
    const g = jobCompletionGate(true, [{ ...forms[1]!, status: "open" }]);
    expect(g.blocked).toBe(false);
  });

  it("stops blocking once the required form is finished", () => {
    const g = jobCompletionGate(true, [{ ...forms[0]!, status: "complete" }, forms[1]!]);
    expect(g.blocked).toBe(false);
  });

  it("a job with no forms is never blocked", () => {
    expect(jobCompletionGate(true, []).blocked).toBe(false);
  });
});
