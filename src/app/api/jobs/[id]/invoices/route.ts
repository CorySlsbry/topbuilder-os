import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, BOOKS_ROLES } from "@/modules/auth-tenancy";
import { getJobCustomerId, DEFAULT_POSTING_ACCOUNTS } from "@/modules/field-ops";
import { issueInvoice, listInvoices } from "@/modules/sales-invoicing";
import { memberDiscountBps } from "@/modules/agreements";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

export const GET = route(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope();
    const { id } = await ctx.params;
    return NextResponse.json({ invoices: await listInvoices(scope, id) });
  },
);

const Body = z.object({
  subtotalCents: z.number().int().positive(),
  retainageBps: z.number().int().min(0).max(5000).default(0),
  materialsCostCents: z.number().int().nonnegative().optional(),
  memo: z.string().trim().max(500).optional(),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...BOOKS_ROLES], departments: ["field"] });
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    // ⛔ THE DISCOUNT THE MEMBER WAS ACTUALLY SOLD.
    //
    // `membership_plans.discount_bps` is collected on the plan form, printed
    // as "15% off repairs" on every plan card, and stored on every
    // agreement. `memberDiscountBps()` existed, worked, and had ZERO callers
    // — because `issueInvoice` had no discount parameter to hand it to. A
    // member sold 15% off was billed full price by the software, every time.
    //
    // Looked up HERE rather than inside sales-invoicing, because that module
    // importing agreements is the cycle the ports were arranged to avoid.
    // The route is where two modules are allowed to meet.
    const customerId = await getJobCustomerId(scope, id);
    const discountBps = customerId ? await memberDiscountBps(scope, customerId) : 0;

    const invoice = await issueInvoice(scope, {
      jobId: id,
      accounts: DEFAULT_POSTING_ACCOUNTS,
      discountBps,
      ...parsed.data,
    });
    return NextResponse.json(invoice, { status: 201 });
  },
);
