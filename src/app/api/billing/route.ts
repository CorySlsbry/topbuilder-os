import { NextResponse } from "next/server";
import { requireScope } from "@/modules/auth-tenancy";
import { getSubscription, PLAN_LIST, billingEnabled, priceExists } from "@/modules/billing";
import { route } from "@/lib/http/route";

export const dynamic = "force-dynamic";

// The billing screen's data. Any member may SEE the plan (it explains seat
// limits they will hit); only the owner can change it.
export const GET = route(async () => {
  const scope = await requireScope();
  const subscription = await getSubscription(scope);

  // ⛔ Only offer plans Stripe can actually charge for. A tier whose price
  // does not exist yet would otherwise render a buy button that throws
  // `price_not_found` at whoever clicks it — which is exactly what shipping
  // the Light catalog entry ahead of its live Stripe price would have done.
  // This makes the catalog rule structural: create the price and the plan
  // appears, with no redeploy and no window where it is visible but broken.
  //
  // The tenant's CURRENT plan is always included even if its price was
  // archived — a customer must never open this page and fail to find the
  // thing they are paying for.
  const plans = billingEnabled()
    ? (
        await Promise.all(
          PLAN_LIST.map(async (p) =>
            p.key === subscription.plan || (await priceExists(p.lookupKey)) ? p : null,
          ),
        )
      ).filter((p) => p !== null)
    : PLAN_LIST; // no Stripe keys at all: show the menu, nothing is buyable anyway

  return NextResponse.json({
    subscription,
    plans,
    canPay: billingEnabled(),
    isOwner: scope.role === "owner",
  });
});
