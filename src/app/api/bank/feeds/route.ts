import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, WRITE_ROLES } from "@/modules/auth-tenancy";
import {
  connectFeed,
  disconnectFeed,
  listConnections,
  listProviders,
  syncFeed,
} from "@/modules/bank-rec";
import { route } from "@/lib/http/route";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

/** Which providers this deployment can actually use, and what is connected. */
export const GET = route(async () => {
  const scope = await requireScope({ departments: ["financials"] });
  const [connections, providers] = await Promise.all([
    listConnections(scope),
    Promise.resolve(listProviders()),
  ]);
  return NextResponse.json({ connections, providers });
});

const Body = z.union([
  z.object({
    action: z.literal("connect"),
    provider: z.enum(["teller", "plaid"]),
    /** Whatever the provider's widget handed the browser. */
    publicToken: z.string().trim().min(8).max(4000),
  }),
  z.object({ action: z.literal("sync"), connectionId: z.string().uuid() }),
  z.object({ action: z.literal("disconnect"), connectionId: z.string().uuid() }),
]);

export const POST = route(async (req: NextRequest) => {
  // Connecting a funding source is an account-level change — same guard as
  // adding a bank account by hand, second factor included. SYNCING is not:
  // it reads data the shop already authorised and posts nothing, and making
  // a refresh button ask for a code is how people stop pressing it.
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_body");

  if (parsed.data.action === "sync") {
    const scope = await requireScope({
      roles: [...WRITE_ROLES, "bookkeeper"],
      departments: ["financials"],
    });
    return NextResponse.json(await syncFeed(scope, parsed.data.connectionId));
  }

  const scope = await requireScope({
    roles: [...WRITE_ROLES, "bookkeeper"],
    departments: ["financials"],
    aal2: true,
  });

  if (parsed.data.action === "disconnect") {
    await disconnectFeed(scope, parsed.data.connectionId);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json(
    await connectFeed(scope, parsed.data.provider, parsed.data.publicToken),
    { status: 201 },
  );
});
