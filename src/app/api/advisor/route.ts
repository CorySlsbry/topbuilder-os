import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdvisorInvite, myMemberships, redeemAdvisorInvite } from "@/modules/auth-tenancy";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";
const Body = z.union([
  z.object({ action: z.literal("create-invite") }),
  z.object({ action: z.literal("redeem"), code: z.string().uuid() }),
]);

export const GET = route(async () => {
  return NextResponse.json({ memberships: await myMemberships() });
});

export const POST = route(async (req: NextRequest) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  if (parsed.data.action === "create-invite") {
    const code = await createAdvisorInvite();
    return NextResponse.json({ code }, { status: 201 });
  }
  const tenantId = await redeemAdvisorInvite(parsed.data.code);
  if (!tenantId) return errorResponse(404, "invite_not_valid");
  return NextResponse.json({ tenantId });
});
