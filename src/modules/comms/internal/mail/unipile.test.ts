import { afterEach, describe, expect, it } from "vitest";
import { accountKind, addressesOf, attachmentPath, toMailMessage, unipile } from "./unipile";

/**
 * The mapping layer, tested without a network — because that is where every
 * real integration bug lives. The HTTP calls are thin; the translation from
 * "whatever the provider sent" into "what the inbox trusts" is not.
 */

const KEY = process.env.UNIPILE_API_KEY;
const URL = process.env.UNIPILE_BASE_URL;
afterEach(() => {
  if (KEY === undefined) delete process.env.UNIPILE_API_KEY;
  else process.env.UNIPILE_API_KEY = KEY;
  if (URL === undefined) delete process.env.UNIPILE_BASE_URL;
  else process.env.UNIPILE_BASE_URL = URL;
});

describe("isConfigured fails closed", () => {
  it("⛔ is false unless BOTH the key and the host are present", () => {
    // A per-account subdomain with no key, or a key with no host, is a
    // half-configured integration — the kind that works in review and throws
    // while a contractor is mid-reply to a customer.
    delete process.env.UNIPILE_API_KEY;
    delete process.env.UNIPILE_BASE_URL;
    expect(unipile.isConfigured()).toBe(false);

    process.env.UNIPILE_API_KEY = "k";
    expect(unipile.isConfigured()).toBe(false);

    delete process.env.UNIPILE_API_KEY;
    process.env.UNIPILE_BASE_URL = "https://api9.unipile.com";
    expect(unipile.isConfigured()).toBe(false);

    process.env.UNIPILE_API_KEY = "k";
    expect(unipile.isConfigured()).toBe(true);
  });
});

describe("accountKind", () => {
  it("recognises the two providers whose reconnect flow differs", () => {
    expect(accountKind("GOOGLE")).toBe("google");
    expect(accountKind("GMAIL")).toBe("google");
    expect(accountKind("MICROSOFT")).toBe("microsoft");
    expect(accountKind("OUTLOOK")).toBe("microsoft");
  });

  it("⛔ falls back to imap, the least-capable option, never a guess", () => {
    // The kind decides which reconnect instructions a shop is shown. Guessing
    // "google" for an unknown type sends an IMAP user to a screen that cannot
    // help them.
    expect(accountKind("SOMETHING_NEW")).toBe("imap");
    expect(accountKind(undefined)).toBe("imap");
    expect(accountKind("")).toBe("imap");
  });
});

describe("addressesOf", () => {
  it("drops empties and trims rather than passing blanks through", () => {
    expect(addressesOf([{ identifier: " person1@example.com " }, { identifier: "" }, {}])).toEqual(["person1@example.com"]);
    expect(addressesOf(undefined)).toEqual([]);
  });
});

describe("toMailMessage", () => {
  const raw = {
    id: "em_1",
    message_id: "<person2@example.com>",
    in_reply_to: "<person3@example.com>",
    account_id: "acct_9",
    from_attendee: { identifier: "dana@example.com", display_name: "Dana Reyes" },
    to_attendees: [{ identifier: "person4@example.com" }],
    cc_attendees: [{ identifier: "person5@example.com" }],
    subject: "  Re: the AC quote  ",
    body_plain: "  Can you come Tuesday?  ",
    body: "<script>alert(1)</script><p>Can you come Tuesday?</p>",
    date: "2026-08-15T14:02:00.000Z",
    attachments: [{ id: "at_1", name: "photo.jpg", mime: "image/jpeg", size: 21_500 }],
  };

  it("normalises the fields the inbox actually uses", () => {
    const m = toMailMessage(raw, "fallback");
    expect(m.externalId).toBe("em_1");
    expect(m.accountExternalId).toBe("acct_9");
    expect(m.messageId).toBe("<person2@example.com>");
    expect(m.inReplyTo).toBe("<person3@example.com>");
    expect(m.fromAddress).toBe("dana@example.com");
    expect(m.fromName).toBe("Dana Reyes");
    expect(m.to).toEqual(["person4@example.com"]);
    expect(m.cc).toEqual(["person5@example.com"]);
    expect(m.subject).toBe("Re: the AC quote");
    expect(m.receivedAt).toBe("2026-08-15T14:02:00.000Z");
    expect(m.attachments).toEqual([
      { externalId: "at_1", filename: "photo.jpg", mimeType: "image/jpeg", bytes: 21_500 },
    ]);
  });

  it("⛔ takes the PLAIN body and never the HTML one", () => {
    // The sender is by definition unauthenticated, and the inbox renders into a
    // real page under a nonce CSP. This is the single largest XSS surface this
    // product could grow, so the HTML field is not read at all — not sanitized,
    // not escaped, not read.
    const m = toMailMessage(raw, "fallback");
    expect(m.text).toBe("Can you come Tuesday?");
    expect(m.text).not.toContain("<script");
    expect(m.text).not.toContain("<p>");
  });

  it("⛔ a message with no plain part is EMPTY, not the HTML one", () => {
    const m = toMailMessage({ ...raw, body_plain: undefined }, "fallback");
    expect(m.text).toBe("");
  });

  it("falls back to the requested account when the provider omits it", () => {
    // Otherwise a message lands attributed to no mailbox and disappears from
    // every per-account view.
    expect(toMailMessage({ id: "e", account_id: undefined }, "acct_fallback").accountExternalId).toBe(
      "acct_fallback",
    );
  });

  it("survives a sparse payload without throwing", () => {
    // A sync that 500s because one message lacked a subject drops the whole
    // batch, including the messages that were fine.
    const m = toMailMessage({ id: "e" }, "acct");
    expect(m.subject).toBe("");
    expect(m.fromAddress).toBe("");
    expect(m.to).toEqual([]);
    expect(m.attachments).toEqual([]);
    expect(m.messageId).toBeNull();
  });
});

describe("⛔ attachmentPath addresses the MESSAGE, not the attachment twice", () => {
  it("puts the message id in the path and the attachment id in the child slot", () => {
    // Regression: both segments were filled with the attachment id, so every
    // download would have asked for an email that does not exist. It was the
    // one function in this file with no test — a URL builder taking two
    // similar-looking ids needs an assertion, not a careful reading.
    expect(attachmentPath("acct_1", "em_7", "at_9")).toBe(
      "emails/em_7/attachments/at_9?account_id=acct_1",
    );
  });

  it("the two ids are never the same segment", () => {
    const p = attachmentPath("acct_1", "em_7", "at_9");
    expect(p).toContain("emails/em_7/");
    expect(p).not.toContain("emails/at_9/");
  });

  it("encodes ids that would otherwise break the path", () => {
    expect(attachmentPath("a/1", "e 7", "at#9")).toBe(
      "emails/e%207/attachments/at%239?account_id=a%2F1",
    );
  });
});
