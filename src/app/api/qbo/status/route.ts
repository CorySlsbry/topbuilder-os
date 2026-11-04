import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { getQboStatus } from "@/modules/qbo-bridge";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const scope = await requireScope({ departments: ["financials"] });
  return NextResponse.json(await getQboStatus(scope));
});
