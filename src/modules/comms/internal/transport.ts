import "server-only";
import { HttpError } from "@/lib/http/errors";

// Outbound message transports — email (Resend) + SMS (Twilio), raw REST,
// key-gated, FAIL CLOSED. There is exactly one rule about who may call
// this module: only executors running under the action gate (a human said
// yes) or direct owner-initiated routes. Agents cannot reach transports
// except through an approved action.

export class CommsError extends HttpError {
  constructor(status: 502 | 503, code: string) {
    super(status, code);
  }
}

export function transportsAvailable(): { email: boolean; sms: boolean } {
  return {
    email: Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM),
    sms: Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_FROM,
    ),
  };
}

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (!transportsAvailable().email) throw new CommsError(503, "email_not_configured");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
  });
  if (!res.ok) throw new CommsError(502, `email_send_failed:${res.status}`);
}

export async function sendSms(
  to: string,
  text: string,
  /** Per-tenant sender (Cory 2026-08-03: every tenant gets its own number). The
   *  env TWILIO_FROM is the platform fallback, not the norm. */
  from?: string,
): Promise<void> {
  if (!transportsAvailable().sms) throw new CommsError(503, "sms_not_configured");
  const sender = from || process.env.TWILIO_FROM!;
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: to,
        From: sender,
        Body: text.slice(0, 1500),
      }),
    },
  );
  if (!res.ok) throw new CommsError(502, `sms_send_failed:${res.status}`);
}

/** Best-channel delivery: SMS first (trades live in texts), then email.
 *  Returns how it went out — 'none' means keys aren't set yet, and the
 *  caller falls back to copy-the-text (today's behavior). */
export async function deliverBestEffort(
  contact: { phone?: string | null; email?: string | null },
  subject: string,
  text: string,
): Promise<"sms" | "email" | "none"> {
  const t = transportsAvailable();
  if (t.sms && contact.phone) {
    await sendSms(contact.phone, text);
    return "sms";
  }
  if (t.email && contact.email) {
    await sendEmail(contact.email, subject, text);
    return "email";
  }
  return "none";
}
