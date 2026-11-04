import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { publicCreateIntake } from "@/modules/intake";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

// PUBLIC (no session): the tenant's "request an appointment" form. Creates
// ONLY an intake row — no data is readable through this route. The
// honeypot field ("website") silently accepts-and-drops bots.
const Body = z.object({
  name: z.string().trim().min(1).max(160),
  phone: z.string().max(40).optional(),
  email: z.string().email().max(160).optional().or(z.literal("")),
  address: z.string().max(240).optional(),
  description: z.string().max(1000).optional(),
  preferredWindow: z.enum(["any", "morning", "afternoon"]).optional(),
  website: z.string().optional(), // honeypot — humans never fill this
  nonce: z.string().max(64).optional(),
});

export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ slug: string }> }) => {
    const { slug } = await ctx.params;
    if (!/^[a-z0-9-]{1,60}$/.test(slug)) return errorResponse(404, "unknown_tenant");
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");
    if (parsed.data.website) return NextResponse.json({ ok: true }); // bot: pretend success
    const r = await publicCreateIntake(slug, {
      source: "web",
      externalId: parsed.data.nonce ?? randomUUID(),
      name: parsed.data.name,
      phone: parsed.data.phone,
      email: parsed.data.email || undefined,
      address: parsed.data.address,
      description: parsed.data.description,
      preferredWindow: parsed.data.preferredWindow,
    });
    return NextResponse.json({ ok: true, duplicate: r.duplicate }, { status: 201 });
  },
);
