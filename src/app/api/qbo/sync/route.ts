import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { runAccountantSync, setSyncEnabled } from "@/modules/qbo-bridge";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.union([
  z.object({ action: z.literal("run") }),
  z.object({ action: z.literal("enable"), enabled: z.boolean() }),
]);

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: ["owner", "admin"] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  if (parsed.data.action === "enable") {
    await setSyncEnabled(scope, parsed.data.enabled);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json(await runAccountantSync(scope));
});
