import { NextResponse } from "next/server";
import { z } from "zod";
import { WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { sendReply } from "@/modules/comms";
import { idempotent } from "@/lib/http/idempotency";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  body: z.string().trim().min(1).max(4000),
  /** 'note' stays inside the building. 'auto' picks the live channel. */
  channel: z.enum(["auto", "note"]).default("auto"),
  subject: z.string().trim().max(200).optional(),
  /** Was this text produced by the polish helper? Recorded on the message —
   *  "did a machine write this?" is a question an owner may ask about their
   *  own outbound messages, and the honest answer needs to be stored. */
  polished: z.boolean().default(false),
});

/**
 * Send a reply.
 *
 * IDEMPOTENCY IS REQUIRED here, not optional. This is a route whose retry
 * sends a second text to a real customer — the one failure mode where "just
 * try again" costs the shop something. The client mints a key when the person
 * starts typing and holds it until the send succeeds.
 */
export const POST = route(
  idempotent<{ params: Promise<{ id: string }> }>(
    "inbox.reply",
    { scope: { roles: WRITE_ROLES }, require: true },
    async (body, scope, ctx) => {
      await assertCapability(scope, "comms");
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");
      const { id } = await ctx.params;
      const r = await sendReply(scope, {
        conversationId: id,
        body: parsed.data.body,
        channel: parsed.data.channel,
        subject: parsed.data.subject,
        polished: parsed.data.polished,
      });
      return NextResponse.json(r);
    },
  ),
);
