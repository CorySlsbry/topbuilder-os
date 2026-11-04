/**
 * Where Stripe sends a portal customer after checkout.
 *
 * Deliberately carries NO portal token: Stripe stores success_url and
 * cancel_url on the session, so anything in this path is visible in the Stripe
 * dashboard forever. The customer returns to their portal using the link the
 * shop already sent them.
 */
export const dynamic = "force-dynamic";

export default async function PortalPaidPage({
  searchParams,
}: {
  searchParams: Promise<{ paid?: string }>;
}) {
  const { paid } = await searchParams;
  const succeeded = paid === "1";

  return (
    <main className="pagebody" style={{ maxWidth: 560, margin: "48px auto" }}>
      <div className="card">
        {succeeded ? (
          <>
            <h1 style={{ marginTop: 0 }}>Payment received ✅</h1>
            <p>
              Thanks — that&apos;s all settled. A receipt is on its way to your
              email, and your contractor can see the payment straight away.
            </p>
          </>
        ) : (
          <>
            <h1 style={{ marginTop: 0 }}>Payment cancelled</h1>
            <p>
              Nothing was charged. You can pay any time from the link your
              contractor sent you.
            </p>
          </>
        )}
        <p className="muted">
          To see your jobs, estimates and invoices again, open the portal link
          from your email or text message. We keep that link out of this page
          on purpose — it&apos;s the key to your account.
        </p>
      </div>
    </main>
  );
}
