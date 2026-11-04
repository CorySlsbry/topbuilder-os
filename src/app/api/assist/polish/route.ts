import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { polish } from "@/modules/comms";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  text: z.string().trim().min(1).max(2000),
  tone: z.enum(["professional", "friendly", "shorter"]).default("professional"),
  /**
   * WHERE the words are going. A closed enum, never a free string: it selects
   * a prompt rule and decides whether the escalation gate runs, so a client
   * must not be able to invent one. Defaults to the strictest useful reading
   * of "a message to a customer".
   */
  surface: z
    .enum(["reply", "estimate", "invoice_memo", "dunning", "review_request", "outreach", "note"])
    .default("reply"),
});

/**
 * "Polish response" — rewrite what the person typed, better.
 *
 * ⛔ THE ONE model call in this product, and the ONE route that may make it.
 * It lives under /api/assist rather than /api/inbox because it is used from
 * the inbox, estimates, invoices and the approvals queue — a path that names
 * one caller invites a second copy for the next one, and the copy that gets
 * copied is eventually the one that auto-replaces what somebody typed.
 * `src/modules/comms/internal/polish-single-caller.test.ts` fails the build if
 * a second route ever calls polish().
 *
 * The ONE model call in this product. It changes nothing: no database write
 * beyond a usage row, no message sent, no record touched. It takes a
 * paragraph and returns a paragraph, and a human decides which one to send.
 *
 * Gated to WRITE_ROLES anyway. Not because a rewrite is dangerous, but because
 * this is the only metered thing in the system and a read-only seat — the
 * public demo included — has no business spending a shop's tokens.
 *
 * Deliberately NOT idempotency-wrapped: asking twice is a legitimate thing to
 * want (you didn't like the first rewrite), and replaying a cached response
 * would make the button feel broken.
 */
export const POST = route(async (req: Request) => {
  const scope = await requireScope({ roles: WRITE_ROLES });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  return NextResponse.json(await polish(scope, parsed.data));
});
