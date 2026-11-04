import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { buildAuthorizeUrl } from "@/modules/qbo-bridge";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  const scope = await requireScope({ roles: ["owner", "admin"] });
  return NextResponse.json({ url: buildAuthorizeUrl(scope) });
});
