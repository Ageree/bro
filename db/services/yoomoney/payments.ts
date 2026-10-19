import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
} from "drizzle-orm";
import { db, yoomoneyPayments } from "@db";
import { claimDirectPurchase } from "@db/services/direct-purchases";
import {
  lockWorkspaceSpending,
  refuseUnresolvedPurchase,
} from "@db/services/spending";
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
    | "account"
    | "title"
    | "requestParams"
    | "shown"
    | "requestId"
    | "amountMinor"
    | "test"
    | "cardId"
    | "cardLabel"
    | "cscRequired"
    | "confirmationQuestion"
    | "conversationChannel"
    | "conversationId"
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
 * expires, while no other payment of the workspace is in flight, and with
 * a yes (`consentHash`) that has paid nothing yet.
 */
export async function claimYoomoneyPayment(
  scope: AccessScope,
  input: Pick<
    YoomoneyPayment,
    "id" | "rootSessionId" | "confirmationQuestion"
  > & {
    readonly callId: string;
    readonly consentHash: string;
    /**
     * The yes is the person's request itself (`agent/lib/payments/direct.ts`):
     * spent for every way Bro pays, not only the wallet.
     */
    readonly direct?: boolean;
  }
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
    const [spent] = await transaction
      .select({ id: yoomoneyPayments.id })
      .from(yoomoneyPayments)
      .where(
        and(
          eq(yoomoneyPayments.workspaceId, scope.workspaceId),
          eq(yoomoneyPayments.consentHash, input.consentHash)
        )
      )
      .limit(1);
    if (spent) return { kind: "consent_spent" as const, payment };
    // Paid with no question, it waits for a purchase elsewhere whose
    // outcome is unknown, as the browser and Lavka do.
    if (input.direct === true) {
      const unresolved = await refuseUnresolvedPurchase(
        transaction,
        scope
      ).then(
        () => false,
        () => true
      );
      if (unresolved) return { kind: "busy" as const, payment };
    }
    if (
      input.direct === true &&
      !(await claimDirectPurchase(
        scope,
        { consentKey: input.consentHash, ref: `yoomoney:${payment.id}` },
        transaction
      ))
    )
      return { kind: "consent_spent" as const, payment };
    const [claimed] = await transaction
      .update(yoomoneyPayments)
      .set({
        state: "submitting",
        callId: input.callId,
        consentHash: input.consentHash,
        submittedAt: now,
      })
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
    // A card payment waiting on the person's bank: the form for its page;
    // null once the bank has sent the person back and the form is spent.
    readonly bankUri?: string | null;
    readonly bankParams?: Record<string, string> | null;
  }
) {
  const settled = input.state === "paid" || input.state === "refused";
  const [payment] = await db
    .update(yoomoneyPayments)
    .set({
      state: input.state,
      paymentId: input.paymentId ?? undefined,
      error: input.error,
      bankUri: input.bankUri,
      bankParams: input.bankParams,
      settledAt: settled ? new Date() : undefined,
    })
    .where(
      and(owned(scope, input), inArray(yoomoneyPayments.state, [...input.from]))
    )
    .returning();
  return payment;
}

/** Bro has told the person how this settled payment went: no notice for it. */
export async function markYoomoneyOutcomeTold(
  scope: AccessScope,
  input: Pick<YoomoneyPayment, "id">
) {
  await db
    .update(yoomoneyPayments)
    .set({ outcomeToldAt: new Date() })
    .where(
      and(
        owned(scope, input),
        inArray(yoomoneyPayments.state, ["paid", "refused"]),
        isNull(yoomoneyPayments.outcomeToldAt)
      )
    );
}

/**
 * Payments in flight the tick reads back (`db/services/yoomoney/settle.ts`),
 * across workspaces, newest first — a stale one whose wallet is gone must
 * not keep a fresh one waiting: one YooMoney may still be processing or
 * whose answer was lost, and a claim left `submitting` past the confirm call
 * that made it. A card payment the person may still be confirming at their
 * bank waits ten minutes from its send: YooMoney has no outcome for it
 * before the bank sends them back, which its return address reads at once.
 * Payments older than a week are left to `status`.
 */
export async function yoomoneyPaymentsToReadBack(now: Date, limit = 20) {
  const sentBefore = (ms: number) =>
    lt(yoomoneyPayments.submittedAt, new Date(now.getTime() - ms));
  return db
    .select()
    .from(yoomoneyPayments)
    .where(
      and(
        gt(
          yoomoneyPayments.submittedAt,
          new Date(now.getTime() - 7 * 86_400_000)
        ),
        or(
          eq(yoomoneyPayments.state, "unknown"),
          and(eq(yoomoneyPayments.state, "submitting"), sentBefore(120_000)),
          and(
            eq(yoomoneyPayments.state, "pending"),
            or(isNull(yoomoneyPayments.bankUri), sentBefore(10 * 60_000))
          )
        )
      )
    )
    .orderBy(desc(yoomoneyPayments.submittedAt))
    .limit(limit);
}

/** A notice not sent is taken again by the next tick, for an hour. */
const noticeRetryMs = 60 * 60_000;

/**
 * Settled payments whose outcome nobody told the person — paid or refused
 * on their page, at the bank, or by the tick — taken once for a notice in
 * the conversation they were asked in. Only a payment sent in the last day,
 * and settled half a minute ago or more: Bro's own confirm or status call
 * marks what it tells the moment it settles it.
 */
export async function claimYoomoneyOutcomeNotices(now: Date, limit = 10) {
  const due = await db
    .select({ id: yoomoneyPayments.id })
    .from(yoomoneyPayments)
    .where(
      and(
        inArray(yoomoneyPayments.state, ["paid", "refused"]),
        isNull(yoomoneyPayments.outcomeToldAt),
        isNotNull(yoomoneyPayments.conversationChannel),
        isNotNull(yoomoneyPayments.conversationId),
        gt(yoomoneyPayments.submittedAt, new Date(now.getTime() - 86_400_000)),
        lt(yoomoneyPayments.settledAt, new Date(now.getTime() - 30_000))
      )
    )
    .limit(limit);
  if (due.length === 0) return [];
  return db
    .update(yoomoneyPayments)
    .set({ outcomeToldAt: now })
    .where(
      and(
        inArray(
          yoomoneyPayments.id,
          due.map((row) => row.id)
        ),
        isNull(yoomoneyPayments.outcomeToldAt)
      )
    )
    .returning();
}

/** A notice that did not land is taken again, while its payment is fresh. */
export async function releaseYoomoneyOutcomeNotice(id: string, now: Date) {
  await db
    .update(yoomoneyPayments)
    .set({ outcomeToldAt: null })
    .where(
      and(
        eq(yoomoneyPayments.id, id),
        gt(yoomoneyPayments.settledAt, new Date(now.getTime() - noticeRetryMs))
      )
    );
}
