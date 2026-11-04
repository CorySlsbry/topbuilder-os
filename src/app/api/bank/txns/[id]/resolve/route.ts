import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, BOOKS_ROLES } from "@/modules/auth-tenancy";
import { resolveBankTxn } from "@/modules/bank-rec";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("type", [
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
]);

export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...BOOKS_ROLES], departments: ["financials"] });
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    const result = await resolveBankTxn(scope, id, parsed.data);
    return NextResponse.json(result);
  },
);
