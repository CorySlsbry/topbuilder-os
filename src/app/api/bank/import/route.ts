import { NextResponse, type NextRequest } from "next/server";
import { requireScope, BOOKS_ROLES } from "@/modules/auth-tenancy";
import { importStatement } from "@/modules/bank-rec";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const MAX_BYTES = 4 * 1024 * 1024;

/** Upload a bank statement (CSV/OFX/QFX) — multipart: bankAccountId, file. */
export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...BOOKS_ROLES], departments: ["financials"] });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const bankAccountId = form?.get("bankAccountId");
  if (!form || !(file instanceof File) || typeof bankAccountId !== "string") {
    return errorResponse(400, "file_and_account_required");
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return errorResponse(422, "file_too_large");
  }
  const summary = await importStatement(scope, {
    bankAccountId,
    filename: file.name || "statement",
    content: await file.text(),
  });
  return NextResponse.json(summary, { status: 201 });
});
