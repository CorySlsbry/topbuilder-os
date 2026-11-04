import { describe, expect, it } from "vitest";
import { signingString, twilioSignature, verifyTwilioSignature } from "./twilio-signature";

/**
 * The example from Twilio's security documentation. The load-bearing assertion
 * is the SIGNING STRING — url + every param as key+value in key order — because
 * that is the half of the scheme that is easy to get subtly wrong, and getting
 * it wrong means either a webhook that rejects every real request or one that
 * accepts forged ones. The digest is pinned as a regression check on top.
 */
const TOKEN = "12345";
const URL = "https://mycompany.com/myapp.php?foo=1&bar=2";
const PARAMS = {
  Digits: "1234",
  To: "+18005551212",
  From: "+14158675310",
  Caller: "+14158675310",
  CallSid: "CA1234567890ABCDE",
};
const EXPECTED_STRING =
  "https://mycompany.com/myapp.php?foo=1&bar=2" +
  "CallSidCA1234567890ABCDE" +
  "Caller+14158675310" +
  "Digits1234" +
  "From+14158675310" +
  "To+18005551212";
const EXPECTED_SIG = "GvWf1cFY/Q7PnoempGyD5oXAezc=";

describe("signingString", () => {
  it("reproduces Twilio's documented concatenation exactly", () => {
    expect(signingString(URL, PARAMS)).toBe(EXPECTED_STRING);
  });

  it("sorts by key, not by insertion order", () => {
    const shuffled = {
      CallSid: PARAMS.CallSid,
      From: PARAMS.From,
      Digits: PARAMS.Digits,
      Caller: PARAMS.Caller,
      To: PARAMS.To,
    };
    expect(signingString(URL, shuffled)).toBe(EXPECTED_STRING);
  });
});

describe("twilioSignature", () => {
  it("is HMAC-SHA1 over that string, base64", () => {
    expect(twilioSignature(TOKEN, URL, PARAMS)).toBe(EXPECTED_SIG);
  });

  it("a different URL is a different signature — the reconstructed public URL matters", () => {
    // On Cloud Run `request.url` is the INTERNAL http:// URL. Signing over it
    // produces a signature that never matches, which is why the verifier takes
    // the public origin as an argument instead of reading the request.
    expect(twilioSignature(TOKEN, "http://mycompany.com/myapp.php?foo=1&bar=2", PARAMS)).not.toBe(
      EXPECTED_SIG,
    );
  });
});

describe("verifyTwilioSignature", () => {
  it("accepts the genuine signature", () => {
    expect(verifyTwilioSignature(TOKEN, URL, PARAMS, EXPECTED_SIG)).toBe(true);
  });

  it("rejects a tampered parameter — the whole point", () => {
    expect(verifyTwilioSignature(TOKEN, URL, { ...PARAMS, Digits: "9999" }, EXPECTED_SIG)).toBe(
      false,
    );
  });

  it("rejects an added parameter", () => {
    expect(
      verifyTwilioSignature(TOKEN, URL, { ...PARAMS, Body: "free money" }, EXPECTED_SIG),
    ).toBe(false);
  });

  it("rejects the wrong token", () => {
    expect(verifyTwilioSignature("wrong", URL, PARAMS, EXPECTED_SIG)).toBe(false);
  });

  it("rejects garbage without throwing on a length mismatch", () => {
    expect(verifyTwilioSignature(TOKEN, URL, PARAMS, "")).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL, PARAMS, "short")).toBe(false);
  });
});
