import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { draftReply } from "@/modules/comms";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ messageId: z.string().uuid() });

/**
 * "Draft a reply" — for a voicemail nobody has had time to answer.
 *
 * Takes a MESSAGE ID, not text. The caller does not get to choose what the
 * model sees: the module loads one row and reads one column of it, under RLS,
 * inside the tenant scope. A route that accepted a transcript would let a
 * client feed the model anything it liked and call the result a draft of that
 * customer's voicemail.
 *
 * Gated to WRITE_ROLES for the same reason as polish: this is metered, and a
 * read-only seat — the public demo included — has no business spending a
 * shop's tokens. Not idempotency-wrapped, because asking for a second draft is
 * a legitimate thing to want.
 *
 * It changes nothing. No message is sent, no record is touched beyond a usage
 * row, and the result lands in a box a human then edits and decides about.
 */
export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: WRITE_ROLES });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  return NextResponse.json(await draftReply(scope, parsed.data.messageId));
});
