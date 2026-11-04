import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { getPricebookPhoto, setPricebookPhoto } from "@/modules/estimating";
import { getObject, isAllowedUpload, putObject } from "@/lib/storage";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const MAX_BYTES = 4 * 1024 * 1024;

// The menu photo. Same discipline as job attachments: type/size-gated,
// server-generated key (never caller paths), served only through this
// authorized route (RLS scopes the lookup).
export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...WRITE_ROLES], departments: ["field"] });
    const { id } = await ctx.params;
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return errorResponse(400, "file_required");
    if (!file.type.startsWith("image/") || !isAllowedUpload(file.type)) {
      return errorResponse(422, "images_only");
    }
    if (file.size > MAX_BYTES) return errorResponse(422, "too_large");
    const key = `tenants/${scope.tenantId}/pricebook/${randomUUID()}.${
      file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg"
    }`;
    await putObject(key, Buffer.from(await file.arrayBuffer()), file.type);
    await setPricebookPhoto(scope, id, key, file.type);
    return NextResponse.json({ ok: true }, { status: 201 });
  },
);

export const GET = route(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope();
    const { id } = await ctx.params;
    const photo = await getPricebookPhoto(scope, id);
    if (!photo) return errorResponse(404, "not_found");
    const bytes = await getObject(photo.photoKey);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": photo.photoType,
        "cache-control": "private, max-age=3600",
      },
    });
  },
);
