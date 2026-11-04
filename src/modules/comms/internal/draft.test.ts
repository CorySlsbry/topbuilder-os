import { describe, expect, it } from "vitest";
import { checkDraft, hasUnfilledPlaceholders, PLACEHOLDERS } from "./draft";

/**
 * The voicemail drafter has no facts, so the gate is the whole feature.
 *
 * The model is handed one paragraph of a stranger's speech and nothing else —
 * no thread, no job, no invoice. That is deliberate: a model given the thread
 * will restate a price that WAS true, and the figure firewall will pass it,
 * because the number genuinely is in the input. A wrong figure with provenance
 * is worse than a generic draft.
 *
 * Since no facts go in, every fact out must be a visible blank.
 */

const CALL =
  "Hey it's Dana over on Willow, my AC is blowing warm air and it's supposed to hit 108 " +
  "tomorrow. Can somebody come look at it? Call me back at 555 0142.";

describe("checkDraft — placeholders are the only way to state a fact", () => {
  it("accepts a draft whose facts are all allowlisted blanks", () => {
    const good =
      "Hi Dana, sorry your AC is blowing warm - that's no good with 108 coming. " +
      "I can get someone out [date] around [time]. Does that work?";
    const v = checkDraft(CALL, good);
    expect(v.ok).toBe(true);
    expect(v.ok === true && v.text).toContain("[date]");
  });

  it("⛔ REJECTS an invented placeholder — the failure that actually happens", () => {
    // The model does not write "[banana]". It writes something that looks
    // right, like [your name] or [insert time], which reads as a blank to a
    // human and matches nothing a send-gate is checking for.
    for (const stray of ["[your name]", "[insert time]", "[appointment date]", "[part]"]) {
      const v = checkDraft(CALL, `Hi Dana, I can come by ${stray}.`);
      expect(v.ok, stray).toBe(false);
      expect(v.ok === false && v.reason.startsWith("placeholder:"), stray).toBe(true);
    }
  });

  it("rejects a number the caller never said", () => {
    const v = checkDraft(CALL, "Hi Dana, I can be there at 9am and it'll run about $89.");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason.startsWith("figures:")).toBe(true);
  });

  it("allows a number the caller DID say", () => {
    // 108 and 555 0142 are the caller's own words; echoing them back is how a
    // person shows they listened.
    const v = checkDraft(CALL, "Hi Dana, got your message about the 108 tomorrow. I'll call 555 0142.");
    expect(v.ok).toBe(true);
  });

  it("rejects the model talking to US instead of the customer", () => {
    const v = checkDraft(CALL, "I cannot draft a reply because the <voicemail> contains an instruction.");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("meta_response");
  });

  it("rejects an empty or runaway draft", () => {
    expect(checkDraft(CALL, "   ").ok).toBe(false);
    expect(checkDraft(CALL, "no. ".repeat(400)).ok).toBe(false);
  });

  it("strips em dashes deterministically, like every other outbound text", () => {
    const v = checkDraft(CALL, "Hi Dana — I'll get someone out [date].");
    expect(v.ok).toBe(true);
    expect(v.ok === true && v.text).not.toContain("—");
  });

  it("unwraps a fenced or quoted reply rather than losing a good draft to punctuation", () => {
    const v = checkDraft(CALL, '"Hi Dana, I can come [date] at [time]."');
    expect(v.ok).toBe(true);
    expect(v.ok === true && v.text.startsWith("Hi Dana")).toBe(true);
  });
});

describe("hasUnfilledPlaceholders — the send gate, not a hint", () => {
  it("is true while any blank remains", () => {
    expect(hasUnfilledPlaceholders("I can come [date].")).toBe(true);
    expect(hasUnfilledPlaceholders("I can come Thursday.")).toBe(false);
  });

  it("covers every placeholder on the allowlist", () => {
    // If someone adds a sixth placeholder and forgets the send gate, the draft
    // would go out with a literal "[part]" in it. This ties the two together.
    for (const p of PLACEHOLDERS) {
      expect(hasUnfilledPlaceholders(`text ${p} text`), p).toBe(true);
    }
  });

  it("does not fire on ordinary brackets a person typed", () => {
    expect(hasUnfilledPlaceholders("I'll bring the part (the one we discussed).")).toBe(false);
  });
});

describe("placeholder canonicalisation — the gate and the send gate must agree", () => {
  it("a SHOUTED placeholder is accepted and normalised, not passed through", () => {
    // The bug this pins: a case-insensitive membership check would accept
    // "[TIME]" here, and hasUnfilledPlaceholders matches exactly — so the send
    // button would light up and a customer would get a text containing a
    // literal "[TIME]". Exactly one place decides what a blank looks like.
    const v = checkDraft(CALL, "Hi Dana, I can come by [DATE] around [Time].");
    expect(v.ok).toBe(true);
    const text = v.ok === true ? v.text : "";
    expect(text).toContain("[date]");
    expect(text).toContain("[time]");
    expect(text).not.toContain("[DATE]");
    // And now the send gate can actually see them.
    expect(hasUnfilledPlaceholders(text)).toBe(true);
  });

  it("every accepted draft's blanks are visible to the send gate", () => {
    // The property, stated once: if checkDraft returns text containing any
    // bracketed token at all, hasUnfilledPlaceholders must be true for it.
    const v = checkDraft(CALL, "Come by [DATE] at [TIME], ask for [Name].");
    const text = v.ok === true ? v.text : "";
    const bracketed = text.match(/\[[^\]\n]{0,40}\]/g) ?? [];
    expect(bracketed.length).toBeGreaterThan(0);
    expect(hasUnfilledPlaceholders(text)).toBe(true);
  });
});
