import "server-only";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { ProspectingError } from "./store";
import {
  QUOTE_LOOKBACK_DAYS,
  rankTargets,
  type CustomerFacts,
  type Target,
} from "./signals";

/**
 * Feed the pure signals engine from the book. Four small fact queries, one
 * assembly, zero cleverness in SQL — the ranking and the reasons live in
 * signals.ts where they are oracle-tested. Dispositions (dismiss/snooze)
 * filter AFTER ranking so a snoozed signal's weight never silently vanishes
 * from a customer who also has live signals.
 */

export interface TargetWithState extends Target {
  /** signals hidden by a disposition, count only — the UI says "1 snoozed" */
  hiddenSignals: number;
}

export async function listTargets(scope: TenantScope): Promise<TargetWithState[]> {
  return withTenant(scope, async (c) => {
    // ⛔ Sequential on purpose: withTenant hands ONE client, and pg only
    // pretends to tolerate concurrent query() calls on a single client
    // (deprecated, removed in pg@9). Four small reads in series cost
    // single-digit milliseconds; the deprecation warning cost a proof run.
    const customers = await c.query<{
        id: string; name: string; last_job_days: string | null;
        agreement_status: string | null; agreement_ends_in: string | null;
      }>(
        `SELECT cu.id, cu.name,
                (SELECT (CURRENT_DATE - max(j.created_at)::date) FROM jobs j
                  WHERE j.customer_id = cu.id)::text AS last_job_days,
                a.status AS agreement_status,
                CASE WHEN a.status = 'active'
                     THEN (a.period_end - CURRENT_DATE)::text END AS agreement_ends_in
           FROM customers cu
           LEFT JOIN LATERAL (
             -- one agreement speaks for the customer: the most recent one
             SELECT status, period_end FROM agreements
              WHERE customer_id = cu.id
              ORDER BY period_end DESC LIMIT 1
           ) a ON true`,
      );
    const equipment = await c.query<{ customer_id: string; id: string; label: string; kind: string; age_years: string }>(
        `SELECT customer_id, id, label, kind,
                FLOOR(EXTRACT(DAY FROM now() - installed_on::timestamptz) / 365.25)::int::text AS age_years
           FROM equipment
          WHERE NOT retired AND installed_on IS NOT NULL`,
      );
    const quotes = await c.query<{ customer_id: string; estimate_id: string; days_ago: string; total_cents: string }>(
        `SELECT j.customer_id, e.id AS estimate_id,
                (CURRENT_DATE - e.created_at::date)::text AS days_ago,
                COALESCE(o.total_cents, 0)::text AS total_cents
           FROM estimates e
           JOIN jobs j ON j.id = e.job_id
           LEFT JOIN LATERAL (
             SELECT max(total_cents) AS total_cents FROM estimate_options
              WHERE estimate_id = e.id
           ) o ON true
          WHERE e.status = 'declined'
            AND e.created_at > CURRENT_DATE - $1::int`,
        [QUOTE_LOOKBACK_DAYS],
      );
    const dispositions = await c.query<{ customer_id: string; signal_key: string; disposition: string; until: string | null }>(
      `SELECT customer_id, signal_key, disposition, until::text FROM target_dispositions`,
    );

    const equipByCustomer = new Map<string, CustomerFacts["equipment"]>();
    for (const e of equipment.rows) {
      const list = equipByCustomer.get(e.customer_id) ?? [];
      list.push({ equipmentId: e.id, label: e.label, kind: e.kind, ageYears: Number(e.age_years) });
      equipByCustomer.set(e.customer_id, list);
    }
    const quotesByCustomer = new Map<string, CustomerFacts["declinedQuotes"]>();
    for (const q of quotes.rows) {
      const list = quotesByCustomer.get(q.customer_id) ?? [];
      list.push({ estimateId: q.estimate_id, daysAgo: Number(q.days_ago), totalCents: Number(q.total_cents) });
      quotesByCustomer.set(q.customer_id, list);
    }

    const facts: CustomerFacts[] = customers.rows.map((cu) => ({
      customerId: cu.id,
      name: cu.name,
      lastJobDaysAgo: cu.last_job_days === null ? null : Number(cu.last_job_days),
      equipment: equipByCustomer.get(cu.id) ?? [],
      agreementStatus: (cu.agreement_status as CustomerFacts["agreementStatus"]) ?? null,
      agreementEndsInDays: cu.agreement_ends_in === null ? null : Number(cu.agreement_ends_in),
      declinedQuotes: quotesByCustomer.get(cu.id) ?? [],
    }));

    // dismissed forever; snoozed until its date passes
    const today = new Date().toISOString().slice(0, 10);
    const hidden = new Set(
      dispositions.rows
        .filter((d) => d.disposition === "dismissed" || (d.until !== null && d.until >= today))
        .map((d) => `${d.customer_id}:${d.signal_key}`),
    );

    return rankTargets(facts)
      .map((t) => {
        const visible = t.signals.filter((s) => !hidden.has(`${t.customerId}:${s.key}`));
        return {
          ...t,
          signals: visible,
          score: visible.reduce((sum, s) => sum + s.weight, 0),
          hiddenSignals: t.signals.length - visible.length,
        };
      })
      .filter((t) => t.signals.length > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  });
}

export async function setTargetDisposition(
  scope: TenantScope,
  input: { customerId: string; signalKey: string; disposition: "dismissed" | "snoozed"; days?: number },
): Promise<void> {
  if (input.disposition === "snoozed" && (input.days ?? 90) <= 0) {
    throw new ProspectingError(422, "snooze_days_positive");
  }
  await withTenant(scope, (c) =>
    c.query(
      `INSERT INTO target_dispositions (tenant_id, customer_id, signal_key, disposition, until, created_by)
       VALUES ($1, $2, $3, $4,
               CASE WHEN $4 = 'snoozed' THEN CURRENT_DATE + $5::int ELSE NULL END, $6)
       ON CONFLICT (tenant_id, customer_id, signal_key)
       DO UPDATE SET disposition = EXCLUDED.disposition, until = EXCLUDED.until`,
      [scope.tenantId, input.customerId, input.signalKey, input.disposition, input.days ?? 90, scope.uid],
    ),
  );
}
