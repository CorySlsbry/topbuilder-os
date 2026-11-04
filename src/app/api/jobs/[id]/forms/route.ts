import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { attachForm, listJobForms } from "@/modules/field-ops";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ templateId: z.string().uuid() });

/**
 * The forms on a job.
 *
 * No department wall, deliberately: a checklist is field work, and the person
 * who has to fill it in is the one holding the wrench. Tenant RLS still
 * decides which job is visible at all, and a form carries no money figures —
 * that is what keeps it safely outside the financials wall.
 */
export const GET = route(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope();
    const { id } = await ctx.params;
    return NextResponse.json({ forms: await listJobForms(scope, id) });
  },
);

/** Attach a template to this job, snapshotting its items as they are today. */
export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...WRITE_ROLES] });
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    const formId = await attachForm(scope, id, parsed.data.templateId);
    return NextResponse.json({ id: formId }, { status: 201 });
  },
);
