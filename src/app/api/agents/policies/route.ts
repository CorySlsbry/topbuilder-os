import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { setMode } from "@/modules/agents";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  agentKey: z.enum(["echo", "financials", "documents", "workforce", "inventory", "dispatch", "booking", "crm", "sales"]),
  mode: z.enum(["off", "approve", "auto"]),
});

// Off/Approve/Auto is an owner/admin decision.
export const PUT = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: ["owner", "admin"] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  await setMode(scope, parsed.data.agentKey, parsed.data.mode);
  return NextResponse.json({ ok: true });
});
