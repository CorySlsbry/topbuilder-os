import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { archiveTemplate, saveTemplate } from "@/modules/field-ops";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Item = z.object({
  kind: z.enum(["check", "text", "number", "photo", "signature"]),
  label: z.string().trim().min(1).max(200),
  hint: z.string().trim().max(300).optional(),
  required: z.boolean().optional(),
});
const Put = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  requiredForCompletion: z.boolean().optional(),
  items: z.array(Item).max(100),
});
const Patch = z.object({ archived: z.boolean() });

/** Replace the template, items and all. See the collection POST for why. */
export const PUT = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...WRITE_ROLES] });
    const { id } = await ctx.params;
    const parsed = Put.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    await saveTemplate(scope, parsed.data, id);
    return NextResponse.json({ ok: true });
  },
);

/**
 * Archive or restore.
 *
 * Never DELETE. A template that has been filled in on a job is part of a
 * signed record, and removing it would erase what somebody was asked. Archived
 * simply stops it being offered on new jobs.
 */
export const PATCH = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...WRITE_ROLES] });
    const { id } = await ctx.params;
    const parsed = Patch.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    await archiveTemplate(scope, id, parsed.data.archived);
    return NextResponse.json({ ok: true });
  },
);
