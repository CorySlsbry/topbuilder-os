import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { listTemplates, saveTemplate } from "@/modules/field-ops";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Item = z.object({
  kind: z.enum(["check", "text", "number", "photo", "signature"]),
  label: z.string().trim().min(1).max(200),
  hint: z.string().trim().max(300).optional(),
  required: z.boolean().optional(),
});

/**
 * ⛔ The whole ordered array, every time.
 *
 * There is no per-item endpoint and there is deliberately no `position` field:
 * position IS the array index, assigned server-side. Two people editing at
 * once can lose an edit; neither can produce an order nobody chose, or two
 * items sitting at position 3.
 */
const Body = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  requiredForCompletion: z.boolean().optional(),
  items: z.array(Item).max(100),
});

export const GET = route(async (req: NextRequest) => {
  const scope = await requireScope();
  const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
  return NextResponse.json({ templates: await listTemplates(scope, { includeArchived }) });
});

export const POST = route(async (req: NextRequest) => {
  // Shaping a form is office work — but it moves no money and signs nothing,
  // so it needs neither the financials wall nor a second factor.
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const id = await saveTemplate(scope, parsed.data);
  return NextResponse.json({ id }, { status: 201 });
});
