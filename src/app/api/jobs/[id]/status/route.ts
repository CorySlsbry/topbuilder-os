import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import { checkJobCompletionGate, setJobStatus } from "@/modules/field-ops";
import { completeVisitForJob } from "@/modules/agreements";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  status: z.enum(["lead", "scheduled", "in-progress", "complete", "closed"]),
  completedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const scope = await requireScope({ roles: [...WRITE_ROLES] });
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_body");

    /**
     * ⛔ THE COMPLETION GATE — the one thing here that can break a shop's day.
     *
     * It is off for every tenant until an owner switches it on, and even then
     * it only fires on the transitions that END the work. Moving a job back to
     * `scheduled` or `in-progress` is never blocked: a rule that stops somebody
     * UNDOING a mistake is a rule that gets the whole feature turned off.
     *
     * The refusal names the forms, because the person hitting this is standing
     * in a driveway and needs to know whether to finish a checklist or call the
     * office — not to conclude the software is broken.
     */
    if (parsed.data.status === "complete" || parsed.data.status === "closed") {
      const gate = await checkJobCompletionGate(scope, id);
      if (gate.blocked) {
        return errorResponse(422, `forms_incomplete:${gate.blockedBy.join(", ")}`);
      }
    }

    await setJobStatus(scope, id, parsed.data.status, parsed.data.completedOn);

    // ⛔ THE HAND THAT WAS MISSING FROM MEMBERSHIP REVENUE RECOGNITION.
    //
    // `completeVisit` was written, unit-tested and documented as the policy
    // in four places — and had no caller outside the endpoint sweep. So an
    // annual plan's deferred revenue never released per visit: the whole
    // year dumped at rollover, on the plan anniversary, whether or not a
    // single tune-up happened.
    //
    // Marking the tune-up job done is the moment the shop KNOWS the
    // obligation was met, and it is a thing a tech already does. Hanging
    // recognition off it removes busy work instead of adding a screen to
    // remember. Composed HERE, at the route, because field-ops importing
    // agreements would be a module cycle.
    //
    // It never throws for a business reason: a job closing must not fail
    // because of a membership.
    let visit: { visitId: string; releasedCents: number } | null = null;
    if (parsed.data.status === "complete" || parsed.data.status === "closed") {
      visit = await completeVisitForJob(
        scope,
        id,
        parsed.data.completedOn ?? new Date().toISOString().slice(0, 10),
      );
    }
    return NextResponse.json({ ok: true, membershipVisit: visit });
  },
);
