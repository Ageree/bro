import { and, eq, inArray, ne } from "drizzle-orm";
import { db, yoomoneyPayments } from "@db";
import { lockWorkspaceSpending } from "@db/services/spending";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * The wallet's payments (`agent/tools/yoomoney_pay.ts`): a checked payment
 * waits as `quoted` for the person's yes, is claimed once (`submitting`)
 * under the workspace's spending lock, and settles from what
 * `process-payment` said. A payment in flight blocks the next one.
 */

type YoomoneyPayment = typeof yoomoneyPayments.$inferSelect;

/** States whose payment may have gone through, or may yet. */
const inFlight = ["submitting", "pending", "unknown"] as const;

function owned(
  scope: AccessScope,
  input: Pick<YoomoneyPayment, "id"> &
    Partial<Pick<YoomoneyPayment, "rootSessionId">>
) {
  return and(
    eq(yoomoneyPayments.id, input.id),
    eq(yoomoneyPayments.workspaceId, scope.workspaceId),
    eq(yoomoneyPayments.userId, scope.userId),
    input.rootSessionId === undefined
      ? undefined
      : eq(yoomoneyPayments.rootSessionId, input.rootSessionId)
  );
}

export async function createYoomoneyPayment(
  scope: AccessScope,
  input: Pick<
    YoomoneyPayment,
    | "id"
    | "rootSessionId"
    | "kind"
    | "title"
    | "requestParams"
    | "shown"
    | "requestId"
    | "amountMinor"
    | "test"
    | "confirmationQuestion"
    | "expiresAt"
  >
) {
  const [payment] = await db
    .insert(yoomoneyPayments)
    .values({ ...input, ...scope })
    .returning();
  if (!payment) throw new Error("The payment could not be stored.");
  return payment;
}

export async function readYoomoneyPayment(
  scope: AccessScope,
  input: Pick<YoomoneyPayment, "id"> &
    Partial<Pick<YoomoneyPayment, "rootSessionId">>
) {
  const [payment] = await db
    .select()
    .from(yoomoneyPayments)
    .where(owned(scope, input))
    .limit(1);
  return payment;
}

/** A payment of the workspace that may have gone through, or may yet. */
export async function yoomoneyPaymentInFlight(scope: AccessScope) {
  const [payment] = await db
    .select()
    .from(yoomoneyPayments)
    .where(
      and(
        eq(yoomoneyPayments.workspaceId, scope.workspaceId),
        inArray(yoomoneyPayments.state, [...inFlight])
      )
    )
    .limit(1);
  return payment;
}

/** A fresh check of the same payment, for the same sum, before the yes ran out. */
export async function renewYoomoneyPayment(
  scope: AccessScope,
  input: Pick<
    YoomoneyPayment,
    "id" | "rootSessionId" | "requestId" | "expiresAt"
  >
) {
  const [payment] = await db
    .update(yoomoneyPayments)
    .set({ requestId: input.requestId, expiresAt: input.expiresAt })
    .where(and(owned(scope, input), eq(yoomoneyPayments.state, "quoted")))
    .returning();
  return payment;
}

/**
 * Takes the payment for `process-payment`, once: only a quoted payment of
 * this conversation, asked about with this very question, before it
 * expires, and while no other payment of the workspace is in flight.
 */
export async function claimYoomoneyPayment(
  scope: AccessScope,
  input: Pick<
    YoomoneyPayment,
    "id" | "rootSessionId" | "confirmationQuestion"
  > & { readonly callId: string }
) {
  return db.transaction(async (transaction) => {
    await lockWorkspaceSpending(transaction, scope);
    const [payment] = await transaction
      .select()
      .from(yoomoneyPayments)
      .where(owned(scope, input))
      .limit(1);
    if (!payment || payment.confirmationQuestion !== input.confirmationQuestion)
      return { kind: "unavailable" as const };
    if (payment.state !== "quoted")
      return { kind: "existing" as const, payment };
    const now = new Date();
    if (payment.expiresAt <= now) return { kind: "expired" as const, payment };
    const [busy] = await transaction
      .select({ id: yoomoneyPayments.id })
      .from(yoomoneyPayments)
      .where(
        and(
          eq(yoomoneyPayments.workspaceId, scope.workspaceId),
          ne(yoomoneyPayments.id, payment.id),
          inArray(yoomoneyPayments.state, [...inFlight])
        )
      )
      .limit(1);
    if (busy) return { kind: "busy" as const, payment };
    const [claimed] = await transaction
      .update(yoomoneyPayments)
      .set({ state: "submitting", callId: input.callId, submittedAt: now })
      .where(and(owned(scope, input), eq(yoomoneyPayments.state, "quoted")))
      .returning();
    if (!claimed) return { kind: "unavailable" as const };
    return { kind: "claimed" as const, payment: claimed };
  });
}

/**
 * What `process-payment` said of a payment in flight: only from one of
 * `from`, so two readers of the same payment settle it once.
 */
export async function settleYoomoneyPayment(
  scope: AccessScope,
  input: Pick<YoomoneyPayment, "id"> & {
    readonly from: readonly (typeof inFlight)[number][];
    readonly state: "pending" | "unknown" | "paid" | "refused";
    readonly paymentId?: string | null;
    readonly error?: string;
  }
) {
  const settled = input.state === "paid" || input.state === "refused";
  const [payment] = await db
    .update(yoomoneyPayments)
    .set({
      state: input.state,
      paymentId: input.paymentId ?? undefined,
      error: input.error,
      settledAt: settled ? new Date() : undefined,
    })
    .where(
      and(owned(scope, input), inArray(yoomoneyPayments.state, [...input.from]))
    )
    .returning();
  return payment;
}
