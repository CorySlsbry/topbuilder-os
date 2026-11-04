import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/modules/auth-tenancy";
import { getBookingSettings, updateBookingSettings } from "@/modules/intake";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/**
 * The switch that decides whether this shop has a booking page on the
 * internet, and the clock it schedules in.
 *
 * Owner/admin only. Not because the settings are sensitive, but because both
 * of them are promises to strangers: `enabled` puts a form on the public web
 * under the shop's name, and `timezone` decides what time a customer is
 * actually being told to expect somebody.
 */
const Body = z.object({
  enabled: z.boolean().optional(),
  daysOut: z.number().int().min(1).max(60).optional(),
  minLeadHours: z.number().int().min(0).max(168).optional(),
  intro: z.string().trim().max(400).optional(),
  // Validated for real by the trigger on `tenants` (it runs
  // `now() AT TIME ZONE <value>`), so a typo is refused at the write rather
  // than becoming a 500 on the booking page at read time.
  timezone: z.string().trim().min(1).max(64).optional(),
});

export const GET = route(async () => {
  const scope = await requireScope({ roles: ["owner", "admin"] });
  return NextResponse.json(await getBookingSettings(scope));
});

export const PATCH = route(async (req: NextRequest) => {
  const scope = await requireScope({ roles: ["owner", "admin"] });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");
  try {
    return NextResponse.json(await updateBookingSettings(scope, parsed.data));
  } catch (err) {
    // The timezone trigger raises a plain exception; turn it into something
    // the settings screen can say out loud.
    if (/time zone .* not recognized|timezone required/i.test((err as Error).message)) {
      return errorResponse(422, "unknown_timezone");
    }
    throw err;
  }
});
