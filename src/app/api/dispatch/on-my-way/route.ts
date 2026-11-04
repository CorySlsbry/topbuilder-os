import { NextResponse } from "next/server";
import { z } from "zod";
import { WRITE_ROLES } from "@/modules/auth-tenancy";
import { assertCapability } from "@/modules/billing";
import { notifyCustomer } from "@/modules/comms";
import { withTenant } from "@/lib/db/tenant";
import { route } from "@/lib/http/route";
import { idempotent } from "@/lib/http/idempotency";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ appointmentId: z.string().uuid() });

/**
 * The tech's one-tap "on my way" — the single most-loved text in the trades.
 * Keyed so a nervous double-tap in a truck doesn't text the customer twice.
 */
export const POST = route(
  idempotent(
    "dispatch.on-my-way",
    { scope: { roles: [...WRITE_ROLES] }, require: true },
    async (body, scope) => {
      await assertCapability(scope, "dispatch");
      const parsed = Body.safeParse(body);
      if (!parsed.success) return errorResponse(400, "invalid_body");

      const appt = await withTenant(scope, (c) =>
        c
          .query<{ customer_id: string; job_name: string; shop: string }>(
            `SELECT j.customer_id, j.name AS job_name, t.name AS shop
               FROM appointments a
               JOIN jobs j ON j.id = a.job_id
               JOIN tenants t ON t.id = a.tenant_id
              WHERE a.id = $1`,
            [parsed.data.appointmentId],
          )
          .then((r) => r.rows[0] ?? null),
      );
      if (!appt) return errorResponse(404, "appointment_not_found");

      const result = await notifyCustomer(scope, {
        customerId: appt.customer_id,
        kind: "on_my_way",
        subject: `${appt.shop}: your technician is on the way`,
        text: `${appt.shop}: your technician is on the way for "${appt.job_name}". Reply STOP to opt out.`,
        ref: parsed.data.appointmentId,
      });
      return NextResponse.json(result);
    },
  ),
);
