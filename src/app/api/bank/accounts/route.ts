import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { createBankAccount, listBankAccounts } from "@/modules/bank-rec";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const scope = await requireScope({ departments: ["financials"] });
  return NextResponse.json({ accounts: await listBankAccounts(scope) });
});

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  glAccountCode: z.string().trim().max(20).optional(),
  institution: z.string().trim().max(120).optional(),
  last4: z.string().trim().max(4).optional(),
  /** A credit card is a LIABILITY, not cash — the kind decides where it
   *  posts, and getting it wrong puts card debt on the balance sheet as
   *  negative cash. */
  kind: z.enum(["checking", "savings", "credit-card", "line-of-credit", "loan"]).optional(),
  /** Most card statements print a purchase as a POSITIVE number; most
   *  checking statements print a debit as negative. */
  chargesArePositive: z.boolean().optional(),
});

export const POST = route(async (req: NextRequest) => {
  // Attaching a funding source is an account-level change, not day-to-day
  // bookkeeping — second factor. Categorizing transactions deliberately is
  // NOT gated: that is the daily loop, and a code per line item is hostile.
  const scope = await requireScope({
    roles: [...WRITE_ROLES, "bookkeeper"],
    departments: ["financials"],
    aal2: true,
  });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const id = await createBankAccount(scope, parsed.data);
  return NextResponse.json({ id }, { status: 201 });
});
