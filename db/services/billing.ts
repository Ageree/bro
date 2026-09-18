import { eq, sql } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { billingAccounts, db, payments } from "@db";
import { ensureScope } from "./scope";

type PaymentInsert = typeof payments.$inferInsert;

const dayMs = 24 * 60 * 60_000;

/** One purchase buys this many days of paid access. */
export const paidPeriodDays = 30;

export async function readBillingState(scope: AccessScope, now = new Date()) {
  const rows = await db
    .select({ paidUntil: billingAccounts.paidUntil })
    .from(billingAccounts)
    .where(eq(billingAccounts.workspaceId, scope.workspaceId))
    .limit(1);
  const paidUntil = rows[0]?.paidUntil ?? null;
  return {
    paid: paidUntil !== null && paidUntil.getTime() > now.getTime(),
    paidUntil,
  };
}

/**
 * Writes what the provider says about one payment. A payment already applied
 * is left alone: its status is the record that paid access was granted, and
 * only `extendPaidUntil` is allowed to reach that state.
 */
export async function recordPayment(
  scope: AccessScope,
  payment: Omit<PaymentInsert, "workspaceId">
) {
  await ensureScope(scope);
  await db
    .insert(payments)
    .values({ ...payment, workspaceId: scope.workspaceId })
    .onConflictDoUpdate({
      target: payments.id,
      set: {
        amountRub: payment.amountRub,
        status: payment.status ?? "created",
        updatedAt: new Date(),
      },
      setWhere: sql`${payments.status} <> 'succeeded' OR ${payments.status} = ${payment.status ?? "created"}`,
    });
}

/**
 * Applies one succeeded payment: paid access moves `days` past whichever of
 * now and the current expiry is later, so paying early adds a month instead of
 * throwing the remainder away.
 *
 * Idempotent on the payment id. YooKassa retries a webhook until it is
 * acknowledged, and the two writes share one transaction, so a redelivery of a
 * payment already marked `succeeded` returns the stored result and extends
 * nothing.
 */
export async function extendPaidUntil(
  scope: AccessScope,
  paymentId: string,
  days: number,
  now = new Date()
) {
  await ensureScope(scope);
  return await db.transaction(async (transaction) => {
    const [claimed] = await transaction
      .insert(payments)
      .values({
        amountRub: 0,
        id: paymentId,
        status: "succeeded",
        workspaceId: scope.workspaceId,
      })
      .onConflictDoUpdate({
        target: payments.id,
        set: { status: "succeeded", updatedAt: now },
        setWhere: sql`${payments.status} <> 'succeeded'`,
      })
      .returning();
    if (!claimed) {
      const [applied] = await transaction
        .select({ paidUntilAfter: payments.paidUntilAfter })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1);
      return { applied: false, paidUntil: applied?.paidUntilAfter ?? null };
    }

    const [account] = await transaction
      .select({ paidUntil: billingAccounts.paidUntil })
      .from(billingAccounts)
      .where(eq(billingAccounts.workspaceId, scope.workspaceId))
      .limit(1);
    const from = Math.max(now.getTime(), account?.paidUntil?.getTime() ?? 0);
    const paidUntil = new Date(from + days * dayMs);

    await transaction
      .insert(billingAccounts)
      .values({ paidUntil, updatedAt: now, workspaceId: scope.workspaceId })
      .onConflictDoUpdate({
        target: billingAccounts.workspaceId,
        set: { paidUntil, updatedAt: now },
      });
    await transaction
      .update(payments)
      .set({ paidUntilAfter: paidUntil, updatedAt: now })
      .where(eq(payments.id, paymentId));

    return { applied: true, paidUntil };
  });
}
