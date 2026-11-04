import { describe, expect, it } from "vitest";
import { KINDS } from "./registry";

/**
 * What a human approver may CHANGE, stated per kind and checked here.
 *
 * `decide({type:"revise", edit})` merges `edit` over the payload and executes
 * the result, and `edit` arrives as an open record from the client. This test
 * is the paperwork clause: every editable field a kind opens must be a field
 * somebody deliberately decided to open, and the ids that choose a TARGET must
 * never be among them.
 *
 * The distinction is not privilege — an approver already holds the kind's authz
 * and could do the equivalent thing through the REST route. It is AUDIT: the
 * stored `payload` is what a reviewer reads, and if an edit can retarget the
 * action, the row on file stops describing the action that ran.
 */

/** Words a person may reword. Anything not here needs a written decision. */
const EXPECTED: Record<string, readonly string[]> = {
  "crm.reviewRequest": ["message"],
  "ar.dunningDraft": ["message"],
  "sales.outreachDraft": ["message"],
};

/**
 * Substrings that mark a field as choosing WHICH record is acted on. A kind
 * that opens one of these has almost certainly made a mistake.
 */
const TARGETING = ["id", "cents", "amount", "account", "code", "week", "qty", "date"];

describe("per-kind revision allowlists", () => {
  it("closed by default — a kind is not revisable unless it says so", () => {
    const opened = Object.entries(KINDS)
      .filter(([, spec]) => spec.editable && spec.editable.length > 0)
      .map(([kind]) => kind)
      .sort();
    // If this fails, a kind gained a revisable field. That is allowed — but it
    // has to be a decision somebody wrote down here, not a default.
    expect(opened).toEqual(Object.keys(EXPECTED).sort());
  });

  it("no kind lets an approver retarget which record is acted on", () => {
    const offenders: string[] = [];
    for (const [kind, spec] of Object.entries(KINDS)) {
      for (const field of spec.editable ?? []) {
        const lower = field.toLowerCase();
        if (TARGETING.some((t) => lower.includes(t))) offenders.push(`${kind}.${field}`);
      }
    }
    // e.g. opening `invoiceId` would let "approve this reminder" send a
    // reminder about a completely different invoice, while the payload on
    // file still names the first one.
    expect(offenders).toEqual([]);
  });

  it("every opened field matches what was decided", () => {
    for (const [kind, fields] of Object.entries(EXPECTED)) {
      expect([...(KINDS[kind]?.editable ?? [])].sort(), kind).toEqual([...fields].sort());
    }
  });

  it("only ALWAYS_HITL kinds are revisable — an auto kind has no human to revise it", () => {
    for (const kind of Object.keys(EXPECTED)) {
      expect(KINDS[kind]?.alwaysHitl, kind).toBe(true);
    }
  });
});
