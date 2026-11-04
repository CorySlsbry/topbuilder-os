import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { getCommsSettings, updateCommsSettings } from "@/modules/comms";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  reminderEnabled: z.boolean().optional(),
  onMyWayEnabled: z.boolean().optional(),
  receiptEnabled: z.boolean().optional(),
  visitDueEnabled: z.boolean().optional(),
  googleReviewUrl: z.string().trim().max(300).optional(),
  // The number + A2P status are OPERATOR-set (buying the number and clearing
  // carrier registration happens outside the product), so the tenant PATCH
  // deliberately cannot touch sms_number / sms_status — a shop typing a
  // random number here would silently break every text.
});

/** What the shop's automatic messages do. Owner/admin surface. */
export const GET = route(async () => {
  const scope = await requireScope({ roles: ["owner", "admin"] });
  await assertCapability(scope, "comms");
  return NextResponse.json(await getCommsSettings(scope));
});

export const PATCH = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: ["owner", "admin"] });
  await assertCapability(scope, "comms");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  await updateCommsSettings(scope, parsed.data);
  return NextResponse.json(await getCommsSettings(scope));
});
