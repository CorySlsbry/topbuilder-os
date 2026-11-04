import { describe, expect, it } from "vitest";
import {
  consentKeyword,
  formatPhone,
  normalizeContact,
  normalizeEmail,
  normalizePhone,
} from "./contact";

/**
 * These vectors are the CONTRACT with app.normalize_phone() in migration 0040.
 * If the two ever disagree, the inbox grows one thread per formatting style
 * and the customer link silently never happens — a bug that reads as
 * flakiness. Change one, change both, and change these.
 */
describe("normalizePhone", () => {
  it("collapses every way a US number gets typed into one key", () => {
    for (const raw of [
      "602-555-0134",
      "(602) 555-0134",
      "6025550134",
      "+1 602 555 0134",
      "1-602-555-0134",
      " 602.555.0134 ",
      "+16025550134",
    ]) {
      expect(normalizePhone(raw), raw).toBe("+16025550134");
    }
  });

  it("keeps a non-NANP number usable instead of collapsing it", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("empty and junk resolve to '' — the caller's signal for 'unusable'", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone(null)).toBe("");
    expect(normalizePhone(undefined)).toBe("");
    expect(normalizePhone("no digits here")).toBe("");
  });
});

describe("normalizeEmail", () => {
  it("case and whitespace fold", () => {
    expect(normalizeEmail("  Ruth.Delgado@Example.COM ")).toBe("ruth.delgado@example.com");
  });
  it("plus-addressing is NOT folded — it is a different reply-to", () => {
    expect(normalizeEmail("person1@example.com")).not.toBe(normalizeEmail("person2@example.com"));
  });
});

describe("normalizeContact", () => {
  it("dispatches on kind", () => {
    expect(normalizeContact("phone", "(480) 555-0171")).toBe("+14805550171");
    expect(normalizeContact("email", "person3@example.com")).toBe("person3@example.com");
  });
});

describe("formatPhone", () => {
  it("renders NANP for humans and passes anything else through", () => {
    expect(formatPhone("+16025550134")).toBe("(602) 555-0134");
    expect(formatPhone("+442079460958")).toBe("+442079460958");
  });
});

describe("consentKeyword", () => {
  it("recognises the carrier keywords in any case, with trailing punctuation", () => {
    expect(consentKeyword("STOP")).toBe("stop");
    expect(consentKeyword(" stop. ")).toBe("stop");
    expect(consentKeyword("Unsubscribe")).toBe("stop");
    expect(consentKeyword("START")).toBe("start");
    expect(consentKeyword("help")).toBe("help");
  });

  it("a sentence CONTAINING the word is not an opt-out", () => {
    // Muting a customer because they wrote "don't stop by until 3" would be a
    // silent, invisible failure — they'd never hear from the shop again.
    expect(consentKeyword("don't stop by until 3")).toBeNull();
    expect(consentKeyword("Can you stop the leak?")).toBeNull();
    expect(consentKeyword("please cancel my appointment tomorrow")).toBeNull();
  });

  it("ordinary messages are not keywords", () => {
    expect(consentKeyword("Thanks, see you then")).toBeNull();
    expect(consentKeyword("")).toBeNull();
  });
});
