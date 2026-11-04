import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { getMessageMedia } from "@/modules/comms";
import { getObject } from "@/lib/storage";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * Serve a photo a customer texted in.
 *
 * Same rule as job attachments: never a public URL. The lookup runs under the
 * caller's RLS scope, so another tenant's media id simply resolves to nothing
 * — the authorization is the query, not a check bolted next to it.
 */
export const GET = route(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope();
    await assertCapability(scope, "comms");
    const { id } = await ctx.params;
    const meta = await getMessageMedia(scope, id);
    if (!meta) return errorResponse(404, "not_found");
    const bytes = await getObject(meta.storageKey);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": meta.contentType,
        "content-disposition": "inline",
        "cache-control": "private, max-age=300",
      },
    });
  },
);
