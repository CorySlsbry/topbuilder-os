import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { runQboImport } from "@/modules/qbo-bridge";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: ["owner", "admin"] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  return NextResponse.json(await runQboImport(scope, parsed.data.asOf));
});
