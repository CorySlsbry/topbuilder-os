import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { createWorker, listWcClasses, listWorkers, upsertWcClass } from "@/modules/workforce";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.union([
  z.object({
    type: z.literal("worker"),
    name: z.string().trim().min(1).max(120),
    trade: z.string().max(60).optional(),
    wcClassCode: z.string().trim().min(1).max(20),
    baseHourlyCents: z.number().int().positive().max(100_000_00),
    ficaBps: z.number().int().min(0).max(3000).optional(),
    unemploymentBps: z.number().int().min(0).max(3000).optional(),
    benefitsHourlyCents: z.number().int().min(0).max(50_000).optional(),
    otherBps: z.number().int().min(0).max(3000).optional(),
  }),
  z.object({
    type: z.literal("wc-class"),
    classCode: z.string().trim().min(1).max(20),
    description: z.string().max(200).optional(),
    ratePer100Cents: z.number().int().min(0).max(100_00),
  }),
]);

export const GET = route(async () => {
  const scope = await requireScope({ departments: ["hr"] });
  await assertCapability(scope, "workforce");
  const [workers, wcClasses] = await Promise.all([listWorkers(scope), listWcClasses(scope)]);
  return NextResponse.json({ workers, wcClasses });
});

// Pay rates + burden are financial data: owner/admin only.
export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: ["owner", "admin"], departments: ["hr"] });
  await assertCapability(scope, "workforce");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  if (parsed.data.type === "wc-class") {
    await upsertWcClass(scope, parsed.data);
    return NextResponse.json({ ok: true }, { status: 201 });
  }
  const id = await createWorker(scope, parsed.data);
  return NextResponse.json({ id }, { status: 201 });
});
