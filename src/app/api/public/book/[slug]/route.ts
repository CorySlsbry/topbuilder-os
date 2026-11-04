import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { publicBookingProfile, publicOpenSlots, publicSelfBook } from "@/modules/intake";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * The public self-booking door. No session, no cookie, no account.
 *
 * Modelled on /api/public/intake/[slug], which has been the unauthenticated
 * write path here for months: a slug guard that 404s quietly rather than
 * confirming which shops exist, a honeypot, and a caller-minted nonce so a
 * double-tap on a phone with one bar is idempotent.
 *
 * Rate limited in src/proxy.ts — and unusually, on GET too (`includeSafe`),
 * because this read computes real capacity against a NAMED business from a
 * slug anyone can see.
 */
const SLUG = /^[a-z0-9-]{1,60}$/;

/** Open windows the customer may pick. */
export const GET = route(
  async (_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) => {
    const { slug } = await ctx.params;
    if (!SLUG.test(slug)) return errorResponse(404, "unknown_tenant");
    const profile = await publicBookingProfile(slug);
    if (!profile) return errorResponse(404, "unknown_tenant");

    // A shop that has not switched booking on gets the same shape, with
    // nothing in it. The page then says "call us" instead of rendering an
    // empty calendar and implying we lost their availability.
    if (!profile.enabled) {
      return NextResponse.json({
        businessName: profile.tenantName,
        enabled: false,
        intro: "",
        days: [],
      });
    }

    const slots = await publicOpenSlots(profile);
    // Grouped by day, because that is how the page asks the question: pick a
    // day, then pick a window. Doing it here keeps the client dumb.
    const byDay = new Map<string, { key: "am" | "pm"; label: string; startsAt: string; endsAt: string }[]>();
    for (const s of slots) {
      const list = byDay.get(s.date) ?? [];
      list.push({ key: s.window, label: s.label, startsAt: s.startsAt, endsAt: s.endsAt });
      byDay.set(s.date, list);
    }
    return NextResponse.json({
      businessName: profile.tenantName,
      enabled: true,
      intro: profile.intro,
      timezone: profile.timezone,
      days: [...byDay.entries()].map(([date, windows]) => ({ date, windows })),
    });
  },
);

const Body = z.object({
  name: z.string().trim().min(1).max(160),
  phone: z.string().trim().max(40).optional(),
  email: z.union([z.string().trim().email().max(160), z.literal("")]).optional(),
  address: z.string().trim().max(240).optional(),
  description: z.string().trim().max(1000).optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  /** Bots fill in every field they can see. A human never sees this one. */
  website: z.string().max(200).optional(),
  nonce: z.string().max(64).optional(),
});

export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ slug: string }> }) => {
    const { slug } = await ctx.params;
    if (!SLUG.test(slug)) return errorResponse(404, "unknown_tenant");

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");

    // Honeypot: look exactly like success and write nothing. Telling a bot it
    // was caught is free information for whoever tunes the bot.
    if (parsed.data.website) return NextResponse.json({ ok: true }, { status: 201 });

    const profile = await publicBookingProfile(slug);
    if (!profile) return errorResponse(404, "unknown_tenant");

    const r = await publicSelfBook(profile, {
      nonce: parsed.data.nonce ?? randomUUID(),
      name: parsed.data.name,
      phone: parsed.data.phone,
      email: parsed.data.email || undefined,
      address: parsed.data.address,
      description: parsed.data.description,
      startsAt: parsed.data.startsAt,
      endsAt: parsed.data.endsAt,
    });
    return NextResponse.json({ ok: true, ...r }, { status: 201 });
  },
);
