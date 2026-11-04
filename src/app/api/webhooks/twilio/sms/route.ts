import { NextResponse, type NextRequest } from "next/server";
import { HttpError } from "@/lib/http/errors";
import { receiveSms, verifyTwilioSignature } from "@/modules/comms";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

/**
 * Inbound SMS/MMS from Twilio — the door this product did not have.
 *
 * ── Authentication ────────────────────────────────────────────────────────
 * X-Twilio-Signature over the exact URL Twilio was configured to call plus
 * every form parameter. FAILS CLOSED: no TWILIO_AUTH_TOKEN, no acceptance.
 * An unauthenticated version of this endpoint would let anyone in the world
 * write messages into any shop's inbox, impersonating their customers — which
 * is worse than it sounds, because the office would act on them.
 *
 * ── The URL problem, which is where this normally breaks ──────────────────
 * The signature covers the URL, and on Cloud Run `request.url` is the INTERNAL
 * http:// address behind the load balancer, not the https:// one Twilio was
 * given. Signing over it fails every time in production and passes every time
 * locally. So the public URL is reconstructed from APP_ORIGIN, with
 * TWILIO_WEBHOOK_URL as an explicit override for anyone fronting this with a
 * different hostname.
 *
 * ── Responses ─────────────────────────────────────────────────────────────
 * Twilio wants TwiML. We return an EMPTY <Response/> — the shop's people
 * answer their own customers; an auto-reply that pretends to be a human is
 * exactly the thing small shops are trying to escape. STOP/HELP replies are
 * handled by Twilio's own Advanced Opt-Out at the carrier, which is both
 * required and better than anything we would send.
 */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function twiml(status = 200): NextResponse {
  return new NextResponse(EMPTY_TWIML, {
    status,
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

function publicUrl(req: NextRequest): string {
  const override = process.env.TWILIO_WEBHOOK_URL;
  if (override) return override;
  const origin = process.env.APP_ORIGIN || process.env.APP_URL || "";
  return `${origin.replace(/\/$/, "")}${req.nextUrl.pathname}`;
}

export const POST = route(async (req: NextRequest) => {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return twiml(503);

  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") params[k] = v;
  }

  const provided = req.headers.get("x-twilio-signature") ?? "";
  if (!verifyTwilioSignature(token, publicUrl(req), params, provided)) {
    // 403 with an empty body: nothing about why, and nothing about who we host.
    return new NextResponse("", { status: 403 });
  }

  const to = params.To ?? "";
  const from = params.From ?? "";
  const sid = params.MessageSid ?? params.SmsMessageSid ?? "";
  if (!to || !from || !sid) return twiml(200);

  const media: { url: string; contentType: string }[] = [];
  const count = Number(params.NumMedia ?? "0");
  for (let i = 0; i < Math.min(Number.isFinite(count) ? count : 0, 10); i++) {
    const url = params[`MediaUrl${i}`];
    const type = params[`MediaContentType${i}`];
    if (url && type) media.push({ url, contentType: type });
  }

  try {
    await receiveSms({ to, from, body: params.Body ?? "", messageSid: sid, media });
  } catch (err) {
    // An unknown destination number or an unusable sender is a 200 to Twilio:
    // there is nothing for the carrier to retry, and a 5xx would make it try
    // this same doomed message for hours. Real failures still surface as 500
    // through the route wrapper so Twilio retries something that might work.
    if (err instanceof HttpError && err.status < 500) return twiml(200);
    throw err;
  }
  return twiml(200);
});
