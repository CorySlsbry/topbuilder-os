import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { getAttachment } from "@/modules/field-ops";
import { getObject } from "@/lib/storage";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * Serve an attachment's bytes — AUTHORIZED (session + RLS scope the lookup;
 * a foreign tenant's attachment id simply resolves to nothing). Dev serves
 * from local disk; prod swaps to a GCS V4 signed-URL redirect.
 */
export const GET = route(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope();
    const { id } = await ctx.params;
    const meta = await getAttachment(scope, id);
    if (!meta) return errorResponse(404, "not_found");
    const bytes = await getObject(meta.storageKey);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": meta.contentType,
        "content-disposition": `inline; filename="${(meta.originalName ?? "file").replace(/[^\w.\-]/g, "_")}"`,
        "cache-control": "private, max-age=300",
      },
    });
  },
);
