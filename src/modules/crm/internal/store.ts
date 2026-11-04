import "server-only";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pool";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { HttpError } from "@/lib/http/errors";
import { approveChangeOrder, approveEstimate } from "@/modules/estimating";
import { deliverBestEffort } from "@/modules/comms";

export class CrmError extends HttpError {
  constructor(status: 404 | 409 | 422, code: string) {
    super(status, code);
  }
}

// ------------------------------------------------------------- CRM list
export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  jobCount: number;
  openArCents: number;
  lastJobAt: string | null;
}

export async function listCustomers(scope: TenantScope): Promise<CustomerRow[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT cu.id, cu.name, cu.phone, cu.email,
              COUNT(DISTINCT j.id)::int AS "jobCount",
              COALESCE(SUM(i.due_now_cents - i.paid_cents)
                       FILTER (WHERE i.status <> 'void'), 0)::bigint AS "openAr",
              MAX(j.created_at)::text AS "lastJobAt"
         FROM customers cu
         LEFT JOIN jobs j ON j.customer_id = cu.id
         LEFT JOIN invoices i ON i.job_id = j.id
        GROUP BY cu.id ORDER BY cu.name`,
    );
    return (rows as (CustomerRow & { openAr: string })[]).map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      jobCount: r.jobCount,
      openArCents: Math.max(0, Number(r.openAr)),
      lastJobAt: r.lastJobAt,
    }));
  });
}

/**
 * Set a customer's phone and email.
 *
 * This did not exist, and its absence became load-bearing the moment the
 * shared inbox shipped: a customer created by `POST /api/jobs` carries a name
 * and nothing else, and there was no path anywhere in the product to add a
 * number to them afterwards. Contact details arrived only by side effect —
 * booking an intake request, or a customer texting in — so "Message this
 * customer" was dead for exactly the customers a shop types in by hand.
 *
 * Blank means "leave it alone", not "clear it": the common call sets one of
 * the two, and a UI that silently wipes an email because the phone field was
 * the one being filled in is a data-loss bug wearing an edit form.
 */
export async function updateCustomerContact(
  scope: TenantScope,
  customerId: string,
  patch: { name?: string; phone?: string; email?: string },
): Promise<void> {
  await withTenant(scope, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE customers
          SET name  = COALESCE(NULLIF($2, ''), name),
              phone = COALESCE(NULLIF($3, ''), phone),
              email = COALESCE(NULLIF($4, ''), email)
        WHERE id = $1`,
      [customerId, patch.name ?? "", patch.phone ?? "", patch.email ?? ""],
    );
    if (rowCount === 0) throw new CrmError(404, "customer_not_found");
  });
}

// --------------------------------------------------------- portal tokens
export async function createPortalToken(
  scope: TenantScope,
  customerId: string,
): Promise<string> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query<{ token: string }>(
      `INSERT INTO portal_tokens (tenant_id, customer_id, created_by)
       VALUES ($1,$2,$3) RETURNING token`,
      [scope.tenantId, customerId, scope.uid],
    );
    return rows[0]!.token;
  });
}

export async function revokePortalTokens(
  scope: TenantScope,
  customerId: string,
): Promise<number> {
  return withTenant(scope, async (c) => {
    const r = await c.query(
      `UPDATE portal_tokens SET revoked = true WHERE customer_id = $1 AND NOT revoked`,
      [customerId],
    );
    return r.rowCount ?? 0;
  });
}

// ---------------------------------------------------------- public portal
export interface PortalData {
  businessName: string;
  customerName: string;
  jobs: { id: string; jobNo: number; name: string; status: string }[];
  invoices: {
    id: string;
    invoiceNo: number;
    issuedOn: string;
    totalCents: number;
    openCents: number;
    status: string;
  }[];
  estimates: {
    id: string;
    jobName: string;
    status: string;
    options: { id: string; label: string; totalCents: number }[];
  }[];
  /** Change orders the shop has SENT and the customer has not decided. A
   *  draft is the shop's business until they choose to show it. */
  changeOrders: {
    id: string;
    coNo: number;
    jobName: string;
    title: string;
    reason: string;
    totalCents: number;
    lines: { description: string; lineTotalCents: number }[];
  }[];
}

interface PortalCtx {
  tenantId: string;
  customerId: string;
  tenantName: string;
}

async function resolvePortal(token: string): Promise<PortalCtx> {
  const { rows } = await getPool().query<{
    tenant_id: string;
    customer_id: string;
    tenant_name: string;
  }>("SELECT tenant_id, customer_id, tenant_name FROM app.portal_context($1)", [token]);
  const r = rows[0];
  if (!r) throw new CrmError(404, "portal_not_found");
  return { tenantId: r.tenant_id, customerId: r.customer_id, tenantName: r.tenant_name };
}

async function withPortal<T>(
  token: string,
  fn: (c: PoolClient, ctx: PortalCtx) => Promise<T>,
): Promise<T> {
  const ctx = await resolvePortal(token);
  const c = await getPool().connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_tenant', $1, true)", [ctx.tenantId]);
    const result = await fn(c, ctx);
    await c.query("COMMIT");
    return result;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

export async function getPortalData(token: string): Promise<PortalData> {
  return withPortal(token, async (c, ctx) => {
    const cust = await c.query<{ name: string }>(
      `SELECT name FROM customers WHERE id = $1`,
      [ctx.customerId],
    );
    if (!cust.rows[0]) throw new CrmError(404, "portal_not_found");
    const jobs = await c.query(
      `SELECT id, job_no AS "jobNo", name, status FROM jobs
        WHERE customer_id = $1 ORDER BY job_no DESC`,
      [ctx.customerId],
    );
    const invoices = await c.query(
      `SELECT i.id, i.invoice_no AS "invoiceNo", i.issued_on::text AS "issuedOn",
              (i.net_subtotal_cents + i.tax_cents)::bigint AS total,
              GREATEST(i.due_now_cents - i.paid_cents, 0)::bigint AS open,
              i.status
         FROM invoices i
         LEFT JOIN jobs j ON j.id = i.job_id
         LEFT JOIN agreements ag ON ag.id = i.agreement_id
        WHERE COALESCE(j.customer_id, ag.customer_id) = $1 AND i.status <> 'void'
        ORDER BY i.issued_on DESC`,
      [ctx.customerId],
    );
    const estimates = await c.query(
      `SELECT e.id, j.name AS "jobName", e.status,
              COALESCE(json_agg(json_build_object(
                'id', o.id, 'label', initcap(o.tier) || ' — ' || o.title,
                'totalCents', o.total_cents)
                ORDER BY o.total_cents) FILTER (WHERE o.id IS NOT NULL), '[]') AS options
         FROM estimates e
         JOIN jobs j ON j.id = e.job_id
         LEFT JOIN estimate_options o ON o.estimate_id = e.id
        WHERE j.customer_id = $1
        GROUP BY e.id, j.name ORDER BY e.created_at DESC`,
      [ctx.customerId],
    );
    const changeOrders = await c.query(
      `SELECT co.id, co.co_no AS "coNo", j.name AS "jobName", co.title, co.reason,
              co.total_cents::bigint AS total,
              COALESCE(json_agg(json_build_object(
                'description', l.description,
                'lineTotalCents', l.line_total_cents)
                ORDER BY l.line_no) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
         FROM change_orders co
         JOIN jobs j ON j.id = co.job_id
         LEFT JOIN change_order_lines l ON l.change_order_id = co.id
        WHERE j.customer_id = $1 AND co.status = 'sent'
        GROUP BY co.id, j.name ORDER BY co.co_no`,
      [ctx.customerId],
    );

    return {
      businessName: ctx.tenantName,
      customerName: cust.rows[0].name,
      changeOrders: (changeOrders.rows as {
        id: string;
        coNo: string;
        jobName: string;
        title: string;
        reason: string;
        total: string;
        lines: { description: string; lineTotalCents: string }[];
      }[]).map((co) => ({
        id: co.id,
        coNo: Number(co.coNo),
        jobName: co.jobName,
        title: co.title,
        reason: co.reason,
        totalCents: Number(co.total),
        lines: co.lines.map((l) => ({
          description: l.description,
          lineTotalCents: Number(l.lineTotalCents),
        })),
      })),
      jobs: (jobs.rows as { id: string; jobNo: string; name: string; status: string }[]).map(
        (j) => ({ ...j, jobNo: Number(j.jobNo) }),
      ),
      invoices: (invoices.rows as {
        id: string;
        invoiceNo: string;
        issuedOn: string;
        total: string;
        open: string;
        status: string;
      }[]).map((i) => ({
        id: i.id,
        invoiceNo: Number(i.invoiceNo),
        issuedOn: i.issuedOn,
        totalCents: Number(i.total),
        openCents: Number(i.open),
        status: i.status,
      })),
      estimates: (estimates.rows as {
        id: string;
        jobName: string;
        status: string;
        options: { id: string; label: string; totalCents: number }[];
      }[]).map((e) => ({ ...e })),
    };
  });
}

/**
 * The customer approves an estimate option from the portal. The estimate
 * must belong to THIS token's customer (checked inside the portal scope),
 * then the normal estimating port does the real work under a portal
 * principal — auditable as the customer's own act.
 */
export async function portalApproveEstimate(
  token: string,
  estimateId: string,
  optionId: string,
): Promise<{ contractCents: number }> {
  const ctx = await resolvePortal(token);
  // Ownership check under the portal scope:
  await withPortal(token, async (c) => {
    const { rows } = await c.query(
      `SELECT 1 FROM estimates e JOIN jobs j ON j.id = e.job_id
        WHERE e.id = $1 AND j.customer_id = $2`,
      [estimateId, ctx.customerId],
    );
    if (rows.length === 0) throw new CrmError(404, "estimate_not_found");
  });
  const scope: TenantScope = {
    uid: `portal:${ctx.customerId}`,
    tenantId: ctx.tenantId,
    aal: "aal1",
  } as TenantScope;
  const r = await approveEstimate(scope, estimateId, optionId);
  return { contractCents: r.contractCents };
}

/**
 * The customer approves a change order from their own portal.
 *
 * Identical shape to the estimate approval above, and deliberately so: check
 * OWNERSHIP under the portal scope first, then mint a synthetic principal and
 * hand off to the module that owns the rule. The ownership check is the only
 * thing standing between a token and another customer's rows — `jobs`,
 * `change_orders` and friends are tenant-scoped, not customer-scoped — so it
 * goes first, every time, in the same place.
 *
 * `via: "customer"` is recorded on the change order. Which of them said yes —
 * the office relaying a phone call, or the customer tapping approve — is
 * exactly what gets argued about later.
 */
export async function portalApproveChangeOrder(
  token: string,
  changeOrderId: string,
): Promise<{ contractCents: number; coNo: number }> {
  const ctx = await resolvePortal(token);
  await withPortal(token, async (c) => {
    const { rows } = await c.query(
      `SELECT 1 FROM change_orders co JOIN jobs j ON j.id = co.job_id
        WHERE co.id = $1 AND j.customer_id = $2 AND co.status = 'sent'`,
      [changeOrderId, ctx.customerId],
    );
    // A draft the shop has not sent is not visible here, and neither is one
    // already decided — both read as "not found" rather than confirming it
    // exists in a state this token may not act on.
    if (rows.length === 0) throw new CrmError(404, "change_order_not_found");
  });
  const scope: TenantScope = {
    uid: `portal:${ctx.customerId}`,
    tenantId: ctx.tenantId,
    aal: "aal1",
  } as TenantScope;
  const r = await approveChangeOrder(scope, changeOrderId, "customer");
  return { contractCents: r.contractCents, coNo: r.coNo };
}

/** Portal "Pay now": the token must own the invoice; returns a portal-
 *  principal scope the checkout creator can act under. */
export async function getPortalScopeForInvoice(
  token: string,
  invoiceId: string,
): Promise<TenantScope> {
  const ctx = await resolvePortal(token);
  await withPortal(token, async (c) => {
    const { rows } = await c.query(
      `SELECT 1 FROM invoices i
         LEFT JOIN jobs j ON j.id = i.job_id
         LEFT JOIN agreements ag ON ag.id = i.agreement_id
        WHERE i.id = $1 AND COALESCE(j.customer_id, ag.customer_id) = $2`,
      [invoiceId, ctx.customerId],
    );
    if (rows.length === 0) throw new CrmError(404, "invoice_not_found");
  });
  return { uid: `portal:${ctx.customerId}`, tenantId: ctx.tenantId } as TenantScope;
}

// ---------------------------------------------------------------- reviews
export interface ReviewCandidate {
  jobId: string;
  jobNo: number;
  jobName: string;
  customerId: string;
  customerName: string;
  phone: string | null;
}

/** Completed jobs, fully paid, with no review request yet. */
export async function reviewCandidates(scope: TenantScope): Promise<ReviewCandidate[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT j.id AS "jobId", j.job_no AS "jobNo", j.name AS "jobName",
              cu.id AS "customerId", cu.name AS "customerName", cu.phone
         FROM jobs j
         JOIN customers cu ON cu.id = j.customer_id
        WHERE j.status IN ('complete', 'closed')
          AND NOT EXISTS (SELECT 1 FROM review_requests r WHERE r.job_id = j.id)
          AND NOT EXISTS (
            SELECT 1 FROM invoices i
             WHERE i.job_id = j.id AND i.status <> 'void'
               AND i.due_now_cents - i.paid_cents > 0)
          AND EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status = 'paid')
        ORDER BY j.job_no`,
    );
    return (rows as (ReviewCandidate & { jobNo: string })[]).map((r) => ({
      ...r,
      jobNo: Number(r.jobNo),
    }));
  });
}

export async function createReviewRequestTx(
  c: PoolClient,
  scope: TenantScope,
  jobId: string,
  customerId: string,
  /** A human reworded it in the approvals queue. Otherwise the default below. */
  messageOverride?: string,
): Promise<{ reviewUrl: string; message: string; via: "sms" | "email" | "none" }> {
  const ins = await c.query(
    `INSERT INTO review_requests (tenant_id, job_id, customer_id, status)
     VALUES ($1,$2,$3,'sent')
     ON CONFLICT (tenant_id, job_id) DO NOTHING RETURNING id`,
    [scope.tenantId, jobId, customerId],
  );
  if (ins.rows.length === 0) throw new CrmError(409, "review_already_requested");
  // The gate transaction's client carries app.current_uid (the approving
  // member), so the member-read policy on tenants applies here.
  const t = await c.query<{ review_url: string; name: string }>(
    `SELECT review_url, name FROM tenants WHERE id = $1`,
    [scope.tenantId],
  );
  const reviewUrl = t.rows[0]?.review_url || "";
  const biz = t.rows[0]?.name ?? "us";
  const cu = await c.query<{ name: string }>(`SELECT name FROM customers WHERE id = $1`, [
    customerId,
  ]);
  const first = (cu.rows[0]?.name ?? "there").split(" ")[0];
  const message =
    messageOverride?.trim() ||
    `Hi ${first} — thanks for letting ${biz} take care of your job. ` +
      `If you were happy with the work, a quick review helps us more than you know` +
      (reviewUrl ? `: ${reviewUrl}` : ".");
  const contact = await c.query<{ phone: string | null; email: string | null }>(
    `SELECT phone, email FROM customers WHERE id = $1`,
    [customerId],
  );
  const via = await deliverBestEffort(
    contact.rows[0] ?? {},
    `A quick favor from ${biz}`,
    message,
  );
  return { reviewUrl, message, via };
}

// ------------------------------------------------------------ collections
export interface OverdueInvoice {
  invoiceId: string;
  invoiceNo: number;
  jobId: string;
  jobName: string;
  customerId: string;
  customerName: string;
  issuedOn: string;
  openCents: number;
  daysOld: number;
}

export async function overdueInvoices(scope: TenantScope, minDays = 30): Promise<OverdueInvoice[]> {
  return withTenant(scope, async (c) => {
    const { rows } = await c.query(
      `SELECT i.id AS "invoiceId", i.invoice_no AS "invoiceNo",
              j.id AS "jobId", j.name AS "jobName",
              cu.id AS "customerId", cu.name AS "customerName",
              i.issued_on::text AS "issuedOn",
              (i.due_now_cents - i.paid_cents)::bigint AS open,
              (CURRENT_DATE - i.issued_on)::int AS "daysOld"
         FROM invoices i
         LEFT JOIN jobs j ON j.id = i.job_id
         LEFT JOIN agreements ag ON ag.id = i.agreement_id
         JOIN customers cu ON cu.id = COALESCE(j.customer_id, ag.customer_id)
        WHERE i.status IN ('issued', 'partial')
          AND i.due_now_cents - i.paid_cents > 0
          AND i.issued_on <= CURRENT_DATE - $1::int
        ORDER BY i.issued_on`,
      [minDays],
    );
    return (rows as (OverdueInvoice & { open: string; invoiceNo: string })[]).map((r) => ({
      ...r,
      invoiceNo: Number(r.invoiceNo),
      openCents: Number(r.open),
    }));
  });
}

const centsToWords = (cents: number) =>
  `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;

/** Deterministic, friendly dunning text — figures verbatim, tone kind. */
export function dunningMessage(inv: {
  customerName: string;
  jobName: string;
  invoiceNo: number;
  openCents: number;
  daysOld: number;
}): string {
  const first = inv.customerName.split(" ")[0];
  return (
    `Hi ${first} — friendly reminder on invoice #${inv.invoiceNo} for ${inv.jobName}: ` +
    `${centsToWords(inv.openCents)} is still open (sent ${inv.daysOld} days ago). ` +
    `Reply here or call us if anything needs a look — otherwise we appreciate the payment. Thank you!`
  );
}

export async function recordDunningTx(
  c: PoolClient,
  scope: TenantScope,
  invoiceId: string,
  message: string,
): Promise<{ message: string; via: "sms" | "email" | "none" }> {
  const contact = await c.query<{ phone: string | null; email: string | null }>(
    `SELECT cu.phone, cu.email FROM invoices i
       LEFT JOIN jobs j ON j.id = i.job_id
       LEFT JOIN agreements ag ON ag.id = i.agreement_id
       JOIN customers cu ON cu.id = COALESCE(j.customer_id, ag.customer_id)
      WHERE i.id = $1`,
    [invoiceId],
  );
  const via = await deliverBestEffort(
    contact.rows[0] ?? {},
    "A friendly reminder about your invoice",
    message,
  );
  await c.query(
    `INSERT INTO events (tenant_id, name, subject_type, subject_id, actor_uid)
     VALUES ($1, $2, 'invoice', $3, $4)`,
    [scope.tenantId, via === "none" ? "dunning_drafted" : "dunning_sent", invoiceId, scope.uid],
  );
  return { message, via };
}

/**
 * Portal token -> a tenant scope + the customer it belongs to. The card
 * save/confirm routes compose this with the agreements module: the token IS
 * the authentication, and everything downstream is pinned to ITS customer —
 * a portal token can only ever save a card onto its own record.
 */
export async function getPortalCustomerScope(
  token: string,
): Promise<{ scope: TenantScope; customerId: string }> {
  const ctx = await resolvePortal(token);
  return {
    scope: { uid: `portal:${ctx.customerId}`, tenantId: ctx.tenantId },
    customerId: ctx.customerId,
  };
}
