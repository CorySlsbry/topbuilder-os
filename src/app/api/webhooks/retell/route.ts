import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { publicCreateIntake, publicTenantIdBySlug } from "@/modules/intake";
import { recordInboundCall } from "@/modules/comms";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

// Retell voice webhook. The signature is verified with RETELL_WEBHOOK_SECRET;
// without the secret the endpoint FAILS CLOSED (503) — it never accepts
// unsigned calls. Idempotent per call_id. The voice agent is configured to
// POST exactly this shape from its post-call analysis (structured fields only
// — no free-running model output reaches the books).
//
// ── Two outcomes, because a phone call is two different things ────────────
//
//   Somebody talked to the agent and asked for work → an INTAKE REQUEST, the
//   same queue the website form feeds, which the Receptionist can book.
//
//   Nobody answered and they left a message → a VOICEMAIL, which is not a
//   booking request at all. It used to become an intake row with the message
//   crammed into `description`, and the recording and transcript were thrown
//   away. Now it lands in the shop's inbox, on the same thread as that
//   person's texts, unread until a human deals with it.
//
// Either way the call is now ALSO a message in the thread, because from the
// customer's side "I called you and then I texted you" is one conversation.
const Body = z.object({
  call_id: z.string().min(1).max(120),
  tenant_slug: z.string().regex(/^[a-z0-9-]{1,60}$/),
  // Optional so a voicemail from an unknown caller is still accepted — losing
  // the message because the agent never got a name would be the wrong trade.
  name: z.string().trim().max(160).optional(),
  phone: z.string().max(40).optional(),
  address: z.string().max(240).optional(),
  description: z.string().max(1000).optional(),
  preferred_window: z.enum(["any", "morning", "afternoon"]).optional(),
  // ── the call itself ──
  transcript: z.string().max(8000).optional(),
  recording_url: z.string().url().max(500).optional(),
  duration_seconds: z.number().int().min(0).max(86_400).optional(),
  voicemail: z.boolean().optional(),
});

export const POST = route(async (req: NextRequest) => {
  const secret = process.env.RETELL_WEBHOOK_SECRET;
  if (!secret) return errorResponse(503, "webhook_not_configured");

  const raw = await req.text();
  const sig = req.headers.get("x-retell-signature") ?? "";
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return errorResponse(401, "bad_signature");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return errorResponse(400, "invalid_body");
  }
  const parsed = Body.safeParse(parsedJson);
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const d = parsed.data;

  // What the thread shows. Prefer the real transcript; fall back to whatever
  // the agent summarised, so a call never becomes an empty message.
  const spoken =
    (d.transcript ?? "").trim() ||
    (d.description ?? "").trim() ||
    (d.voicemail ? "Voicemail — no transcript available." : "Call handled, no notes.");

  if (d.voicemail) {
    if (!d.phone) return errorResponse(400, "voicemail_requires_phone");
    const tenantId = await publicTenantIdBySlug(d.tenant_slug);
    if (!tenantId) return errorResponse(404, "unknown_tenant");
    const r = await recordInboundCall({
      tenantId,
      callId: d.call_id,
      phone: d.phone,
      callerName: d.name,
      transcript: spoken,
      recordingUrl: d.recording_url,
      durationSeconds: d.duration_seconds,
      voicemail: true,
    });
    return NextResponse.json({ ok: true, duplicate: r.duplicate, kind: "voicemail" });
  }

  // A booking conversation still needs a name for the intake row.
  if (!d.name) return errorResponse(400, "name_required");
  const r = await publicCreateIntake(d.tenant_slug, {
    source: "call",
    externalId: d.call_id,
    name: d.name,
    phone: d.phone,
    address: d.address,
    description: d.description,
    preferredWindow: d.preferred_window,
  });

  // Best effort: the intake request is the part that must not be lost, so a
  // failure to thread the call never fails the webhook (which would make
  // Retell retry a request that already booked the work).
  if (d.phone) {
    await recordInboundCall({
      tenantId: r.tenantId,
      callId: d.call_id,
      phone: d.phone,
      callerName: d.name,
      transcript: spoken,
      recordingUrl: d.recording_url,
      durationSeconds: d.duration_seconds,
      voicemail: false,
    }).catch((err) => console.error("[retell] thread failed:", (err as Error).message));
  }

  return NextResponse.json({ ok: true, duplicate: r.duplicate, kind: "intake" });
});
