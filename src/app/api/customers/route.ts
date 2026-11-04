import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import {
  createPortalToken,
  listCustomers,
  revokePortalTokens,
  updateCustomerContact,
} from "@/modules/crm";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.union([
  z.object({
    action: z.enum(["portal-link", "revoke-links"]),
    customerId: z.string().uuid(),
  }),
  z.object({
    // Contact details. A customer created from a job carries a name and
    // nothing else, and until this existed there was no way to add a phone
    // number to them — which made "Message this customer" dead on arrival for
    // anyone typed in by hand. Blank fields are left alone, never cleared.
    action: z.literal("contact"),
    customerId: z.string().uuid(),
    name: z.string().trim().max(160).optional(),
    phone: z.string().trim().max(40).optional(),
    email: z.string().trim().max(160).optional(),
  }),
]);

export const GET = route(async () => {
  const scope = await requireScope();
  return NextResponse.json({ customers: await listCustomers(scope) });
});

export const POST = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: [...WRITE_ROLES] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  if (parsed.data.action === "contact") {
    await updateCustomerContact(scope, parsed.data.customerId, parsed.data);
    return NextResponse.json({ ok: true });
  }
  if (parsed.data.action === "revoke-links") {
    const revoked = await revokePortalTokens(scope, parsed.data.customerId);
    return NextResponse.json({ revoked });
  }
  const token = await createPortalToken(scope, parsed.data.customerId);
  return NextResponse.json({ url: `/portal/${token}` }, { status: 201 });
});
