import "server-only";
import type { PoolClient } from "pg";
import { withTenant, type TenantScope } from "@/lib/db/tenant";
import { postJournalEntryTx } from "@/modules/ledger";
import { ApError } from "./store";

/**
 * Sending money to vendors, through a LICENSED PARTNER.
 *
 * Why a partner and not a rail: originating ACH ourselves would make us a
 * third-party sender — sponsor bank, NACHA obligations, KYB on every tenant,
 * OFAC screening, and in most structures money-transmitter licensing. A
 * partner (Melio, Bill.com, Relay) holds all of that. We hold an account
 * reference and never touch bank credentials. This is the same reasoning that
 * put payroll with ADP rather than in this codebase.
 *
 * ── The accounting, which is the part that must be right ──────────────────
 *
 * A sent payment has not arrived. It takes 1-3 business days and it can come
 * BACK — NSF, closed account, wrong routing number. So cash is not credited
 * until settlement:
 *
 *   submit    DR 2110 Accounts payable    CR 2115 Payments in transit
 *   settle    DR 2115 Payments in transit CR 1020 Cash
 *   returned  DR 2115 Payments in transit CR 2110 Accounts payable
 *
 * Crediting cash at submission would show money gone that is still in the
 * account, break the bank reconciliation for the whole window, and leave
 * nothing to reverse on a return. On a return the vendor correctly goes back
 * to being owed and the bill reopens.
 *
 * Recording a payment a human already made is a DIFFERENT operation and keeps
 * its existing single posting — see payBill() in store.ts. That money really
 * has left.
 */

const AP = "2110";
const CASH = "1020";
const IN_TRANSIT = "2115";

/** What a bill-pay partner has to be able to do. Deliberately small. */
export interface BillPayProvider {
  readonly key: string;
  /**
   * Send one payment. Returns the provider's id — the idempotency anchor for
   * every status update that follows.
   */
  send(input: {
    accountRef: string;
    vendorName: string;
    amountCents: number;
    memo: string;
    /** Ours, so a retry cannot double-send at the provider either. */
    idempotencyKey: string;
  }): Promise<{ providerRef: string; status: "pending" | "settled" }>;
}

/**
 * No provider is wired yet — the partner account is Cory's to open, since it
 * needs the business's own KYB and a signed agreement.
 *
 * This fails CLOSED and says exactly what is missing, rather than pretending
 * to send. A stub that silently "succeeds" here would be the worst possible
 * bug in this file: the books would say a supplier was paid and no money would
 * have moved.
 */
export const notConfigured: BillPayProvider = {
  key: "none",
  send() {
    throw new ApError(503, "bill_pay_not_connected");
  },
};

export function activeProvider(): BillPayProvider {
  // When the partner is chosen and credentials exist, resolve it here on
  // env config. Until then every send path fails closed.
  return notConfigured;
}

// ------------------------------------------------------------- postings
/**
 * The three entries as PURE data, so the invariant that actually matters can
 * be tested without a database: submit → settle nets to DR AP / CR Cash (the
 * same place a manual payment lands), and submit → returned nets to nothing at
 * all. Get a sign backwards here and the trial balance still balances — it is
 * just wrong, in a way only a confused accountant would eventually catch.
 */
export type BillPayStep = "submitted" | "settled" | "returned";

export function billPayEntryLines(
  step: BillPayStep,
  amountCents: number,
): { accountCode: string; debitCents?: number; creditCents?: number }[] {
  switch (step) {
    case "submitted":
      return [
        { accountCode: AP, debitCents: amountCents },
        { accountCode: IN_TRANSIT, creditCents: amountCents },
      ];
    case "settled":
      return [
        { accountCode: IN_TRANSIT, debitCents: amountCents },
        { accountCode: CASH, creditCents: amountCents },
      ];
    case "returned":
      return [
        { accountCode: IN_TRANSIT, debitCents: amountCents },
        { accountCode: AP, creditCents: amountCents },
      ];
  }
}

export const BILL_PAY_ACCOUNTS = { AP, CASH, IN_TRANSIT } as const;

/** submit: the bill stops being payable, the money is in flight. */
export async function postSubmittedTx(
  c: PoolClient,
  scope: TenantScope,
  billId: string,
  amountCents: number,
  occurredOn: string,
  memo: string,
): Promise<string> {
  return postJournalEntryTx(c, scope, {
    occurredOn,
    memo: `Bill payment sent: ${memo}`,
    sourceType: "ap-payment-sent",
    sourceId: billId,
    lines: [
      { accountCode: AP, debitCents: amountCents },
      { accountCode: IN_TRANSIT, creditCents: amountCents },
    ],
  });
}

/** settle: the money actually left the bank. */
export async function postSettledTx(
  c: PoolClient,
  scope: TenantScope,
  billId: string,
  amountCents: number,
  occurredOn: string,
  memo: string,
): Promise<string> {
  return postJournalEntryTx(c, scope, {
    occurredOn,
    memo: `Bill payment settled: ${memo}`,
    sourceType: "ap-payment-settled",
    sourceId: billId,
    lines: [
      { accountCode: IN_TRANSIT, debitCents: amountCents },
      { accountCode: CASH, creditCents: amountCents },
    ],
  });
}

/** returned: it bounced. The vendor is owed again and the bill reopens. */
export async function postReturnedTx(
  c: PoolClient,
  scope: TenantScope,
  billId: string,
  amountCents: number,
  occurredOn: string,
  memo: string,
  reason: string,
): Promise<string> {
  return postJournalEntryTx(c, scope, {
    occurredOn,
    memo: `Bill payment returned (${reason}): ${memo}`,
    sourceType: "ap-payment-returned",
    sourceId: billId,
    lines: [
      { accountCode: IN_TRANSIT, debitCents: amountCents },
      { accountCode: AP, creditCents: amountCents },
    ],
  });
}

// --------------------------------------------------------------- status
export interface BillPayStatus {
  connected: boolean;
  provider: string;
  status: string | null;
  /** Payments sent and not yet settled — money committed but not gone. */
  inFlightCents: number;
}

export async function billPayStatus(scope: TenantScope): Promise<BillPayStatus> {
  return withTenant(scope, async (c) => {
    const acct = await c.query<{ provider: string; status: string }>(
      "SELECT provider, status FROM bill_pay_accounts WHERE tenant_id = $1",
      [scope.tenantId],
    );
    const flight = await c.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total
         FROM bill_payments WHERE status = 'pending'`,
    );
    const a = acct.rows[0];
    return {
      connected: a?.status === "active",
      provider: a?.provider ?? activeProvider().key,
      status: a?.status ?? null,
      inFlightCents: Number(flight.rows[0]!.total),
    };
  });
}
