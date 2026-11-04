-- Make a payment reference idempotent at the DATABASE, and lock the invoice
-- row while it is being paid.
--
-- The bug: Stripe delivers webhooks AT LEAST ONCE and retries on any non-2xx
-- or timeout. handleCheckoutWebhook did:
--
--     SELECT 1 FROM payments WHERE reference = <session id>   -- tx A, COMMITS
--     ...
--     recordPayment(...)                                      -- tx B, separate
--
-- Two overlapping deliveries of the same session both run the SELECT before
-- either INSERT lands, both see nothing, and both post DR cash / CR AR. A $500
-- card payment becomes $1,000 of cash and -$500 of AR. The books still BALANCE,
-- so nothing alarms — it surfaces weeks later as a bank rec that will not tie
-- or an AR aging the CPA cannot explain. Check-then-act across two transactions
-- is not a dedupe; it is a race with good intentions.
--
-- A UNIQUE constraint is the only thing that actually decides this, because it
-- is evaluated at write time under the same lock the writer holds. The
-- application keeps its pre-check as a cheap fast path, but correctness now
-- rests here.
--
-- Partial (WHERE reference IS NOT NULL) because manual cash/check payments
-- legitimately have no reference, and several NULLs must stay allowed. Scoped
-- by tenant_id so two shops can never collide on each other's references.

-- If this fails, the database already contains a double-posted payment. That
-- is worth knowing loudly rather than papering over: find them with
--   SELECT tenant_id, reference, count(*) FROM payments
--    WHERE reference IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;
-- and reverse the extra posting (never DELETE — the journal is append-only).
CREATE UNIQUE INDEX payments_tenant_reference_uniq
  ON payments (tenant_id, reference)
  WHERE reference IS NOT NULL;

COMMENT ON INDEX payments_tenant_reference_uniq IS
  'Idempotency for at-least-once payment webhooks. recordPayment() catches '
  '23505 on this index and reports the payment as already recorded.';
