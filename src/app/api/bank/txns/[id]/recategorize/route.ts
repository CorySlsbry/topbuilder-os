import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, BOOKS_ROLES } from "@/modules/auth-tenancy";
import { listResolutions, recategorizeBankTxn } from "@/modules/bank-rec";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * Change the answer on a line that is already posted.
 *
 * Same guard as categorizing it the first time — books roles, financials
 * wall — and deliberately NOT a second-factor prompt. A correction is
 * ordinary bookkeeping, it is fully reversible, and every one of them is
 * recorded with a name against it. Making the fix harder than the original
 * mistake is how you end up with books nobody corrects.
 */
const Body = z.object({
  action: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("expense"),
      accountCode: z.string().trim().min(1).max(20),
      remember: z.boolean().optional(),
    }),
    z.object({
      type: z.literal("job-cost"),
      jobId: z.string().uuid(),
      costCode: z.string().trim().min(1).max(20),
      kind: z.enum(["labor", "material", "sub", "equipment", "other"]),
      remember: z.boolean().optional(),
    }),
    z.object({ type: z.literal("personal") }),
    z.object({ type: z.literal("exclude") }),
    z.object({
      type: z.literal("transfer"),
      otherAccountId: z.string().uuid(),
      otherTxnId: z.string().uuid().optional(),
    }),
  z.object({
      type: z.literal("split"),
      // Two or more parts, each a whole answer in miniature. The server
      // enforces that they total the transaction EXACTLY.
      lines: z.array(
        z.discriminatedUnion("type", [
          z.object({
            type: z.literal("expense"),
            accountCode: z.string().trim().min(1).max(20),
            amountCents: z.number().int().positive(),
            memo: z.string().trim().max(200).optional(),
          }),
          z.object({
            type: z.literal("job-cost"),
            jobId: z.string().uuid(),
            costCode: z.string().trim().min(1).max(20),
            kind: z.enum(["labor", "material", "sub", "equipment", "other"]),
            amountCents: z.number().int().positive(),
            memo: z.string().trim().max(200).optional(),
          }),
        ]),
      ).min(2).max(40),
    }),

    // Unlinking a line that was auto-matched to a payment already on the
    // books. It reverses nothing — that entry belongs to the payment.
    z.object({ type: z.literal("unmatch") }),
  ]),
  /** Required, and stored verbatim: an audit trail without a why is a log. */
  reason: z.string().trim().min(1).max(300),
});

export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...BOOKS_ROLES], departments: ["financials"] });
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    const result = await recategorizeBankTxn(scope, id, parsed.data.action, parsed.data.reason);
    return NextResponse.json(result);
  },
);

/** The correction trail for one line — every answer it has ever had. */
export const GET = route(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ departments: ["financials"] });
    const { id } = await ctx.params;
    return NextResponse.json({ resolutions: await listResolutions(scope, id) });
  },
);
