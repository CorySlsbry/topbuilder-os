import { NextResponse, type NextRequest } from "next/server";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { addAttachment, getJobScreen } from "@/modules/field-ops";
import { buildStorageKey, isAllowedUpload, putObject } from "@/lib/storage";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

/** Upload a receipt/photo for a job (multipart form: file, kind?). */
export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...WRITE_ROLES] });
    const { id: jobId } = await ctx.params;
    await getJobScreen(scope, jobId); // 404s (via RLS) if not this tenant's job

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) {
      return errorResponse(400, "file_required");
    }
    if (!isAllowedUpload(file.type)) {
      return errorResponse(422, "unsupported_file_type");
    }
    if (file.size <= 0 || file.size > MAX_BYTES) {
      return errorResponse(422, "file_too_large");
    }
    const kindRaw = form.get("kind");
    const kind =
      kindRaw === "photo" || kindRaw === "document" ? kindRaw : "receipt";

    const key = buildStorageKey(scope.tenantId, jobId, file.type);
    await putObject(key, Buffer.from(await file.arrayBuffer()), file.type);
    const attachmentId = await addAttachment(scope, {
      jobId,
      kind,
      storageKey: key,
      contentType: file.type,
      sizeBytes: file.size,
      originalName: file.name || undefined,
    });
    return NextResponse.json({ id: attachmentId }, { status: 201 });
  },
);
