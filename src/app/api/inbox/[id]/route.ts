import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { getThread, linkThreadCustomer, updateThread } from "@/modules/comms";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One thread: the whole conversation, plus an honest answer about whether a
 * reply can actually leave the building (`reply.channel` / `reply.blocked`).
 *
 * Opening a thread marks it read. Asking someone to press a second button to
 * clear a badge for a message they are looking at is the kind of friction that
 * makes people stop trusting the badge.
 */
export const GET = route(async (_req: NextRequest, ctx: Ctx) => {
  const scope = await requireScope();
  await assertCapability(scope, "comms");
  const { id } = await ctx.params;
  // A viewer (the public demo) reads the thread but must not mutate the
  // unread counter — read-only has to mean read-only, including counters.
  const canWrite = (WRITE_ROLES as readonly string[]).includes(scope.role);
  const thread = await getThread(scope, id, { markRead: canWrite });
  if (!thread) return errorResponse(404, "not_found");
  return NextResponse.json({ thread });
});

const Patch = z.union([
  z.object({
    action: z.literal("update"),
    status: z.enum(["open", "closed"]).optional(),
    assignedTo: z.string().max(200).optional(),
    markRead: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("link-customer"),
    customerId: z.string().uuid().optional(),
    newName: z.string().trim().min(1).max(160).optional(),
  }),
]);

export const PATCH = route(async (req: NextRequest, ctx: Ctx) => {
  const scope = await requireScope({ roles: WRITE_ROLES });
  await assertCapability(scope, "comms");
  const { id } = await ctx.params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");

  if (parsed.data.action === "link-customer") {
    const r = await linkThreadCustomer(scope, id, {
      customerId: parsed.data.customerId,
      newName: parsed.data.newName,
    });
    return NextResponse.json(r);
  }

  await updateThread(scope, id, parsed.data);
  return NextResponse.json({ ok: true });
});
