import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { createCustomer, createJob, listJobs } from "@/modules/field-ops";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const scope = await requireScope();
  return NextResponse.json({ jobs: await listJobs(scope) });
});

const Body = z.object({
  customerName: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  jobType: z
    .enum(["retail", "insurance-restoration", "solar-financed"])
    .default("retail"),
  contractCents: z.number().int().nonnegative().default(0),
  budgetCents: z.number().int().nonnegative().default(0),
  claimNumber: z.string().trim().max(80).optional(),
  carrier: z.string().trim().max(120).optional(),
  // ⛔ These three were columns nothing could write. `deductibleCents` was in
  // `NewJob` and in createJob's INSERT but missing from this schema, so it was
  // silently dropped on every request; adjuster name/phone were not in the
  // input type at all. A column with no writer is a promise the UI cannot keep.
  adjusterName: z.string().trim().max(120).optional(),
  adjusterPhone: z.string().trim().max(40).optional(),
  deductibleCents: z.number().int().nonnegative().optional(),
  acvCents: z.number().int().nonnegative().optional(),
  rcvCents: z.number().int().nonnegative().optional(),
  grossContractCents: z.number().int().nonnegative().optional(),
  dealerFeeCents: z.number().int().nonnegative().optional(),
  lender: z.string().trim().max(120).optional(),
});

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  const b = parsed.data;
  const customerId = await createCustomer(scope, { name: b.customerName });
  const job = await createJob(scope, { ...b, customerId });
  return NextResponse.json(job, { status: 201 });
});
