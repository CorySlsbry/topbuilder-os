import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { getJobScreen, listAttachments, updateJob } from "@/modules/field-ops";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/** One-screen-per-job: the whole picture in one response. */
export const GET = route(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope();
    const { id } = await ctx.params;
    const screen = await getJobScreen(scope, id);
    const attachments = await listAttachments(scope, id);
    return NextResponse.json({ ...screen, attachments });
  },
);

/**
 * Correct a job after it was booked.
 *
 * ⛔ `.strict()` IS THE POINT, not tidiness. The fields this route refuses —
 * `contractCents`, `status`, `jobNo`, `customerId` — are each refused for a
 * real reason (see `updateJob`'s doc comment; the contract one would re-create
 * the data-loss bug migration 0043 exists to prevent). A permissive schema
 * would DROP them silently, so a caller trying to move a contract would get a
 * cheerful 200 and no change. A 400 that names the problem is the honest
 * answer, and it is what makes "the contract moves only through change orders"
 * enforceable rather than merely documented.
 */
const Patch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    jobType: z.enum(["retail", "insurance-restoration", "solar-financed"]).optional(),
    budgetCents: z.number().int().nonnegative().optional(),
    // insurance-restoration. Nullable on purpose: clearing a wrong claim number
    // is a real edit, and `.optional()` alone cannot express it.
    claimNumber: z.string().trim().max(80).nullable().optional(),
    carrier: z.string().trim().max(120).nullable().optional(),
    adjusterName: z.string().trim().max(120).nullable().optional(),
    adjusterPhone: z.string().trim().max(40).nullable().optional(),
    deductibleCents: z.number().int().nonnegative().nullable().optional(),
    acvCents: z.number().int().nonnegative().nullable().optional(),
    rcvCents: z.number().int().nonnegative().nullable().optional(),
    depreciationInvoiced: z.boolean().optional(),
    // solar-financed
    grossContractCents: z.number().int().nonnegative().nullable().optional(),
    dealerFeeCents: z.number().int().nonnegative().nullable().optional(),
    lender: z.string().trim().max(120).nullable().optional(),
    completedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .strict();

export const PATCH = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...WRITE_ROLES] });
    const { id } = await ctx.params;
    const parsed = Patch.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    await updateJob(scope, id, parsed.data);
    // Return the screen the caller already had, so an edit refreshes the page
    // it was made from without a second round trip.
    return NextResponse.json(await getJobScreen(scope, id));
  },
);
