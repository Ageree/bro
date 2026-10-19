import type { yoomoneyPayments } from "@db";
import type { AccessScope } from "@shared/identity/access-scope";
import { findYoomoneyPayment } from "@shared/yoomoney/payments";
import { withYoomoneyToken } from "./connection";

/**
 * What became of a payment whose outcome was lost, by its wallet's history
 * (`findYoomoneyPayment`): absent from the whole history half an hour after
 * it was sent is a payment YooMoney never made — an hour, while the bank's
 * form of a card payment is still unused: the person may open its link
 * late, and a payment they confirm after Bro called it refused would go
 * through. Undefined while it cannot be told.
 */
export async function settlementFromHistory(
  scope: AccessScope,
  payment: typeof yoomoneyPayments.$inferSelect
) {
  const sent = payment.submittedAt ?? payment.createdAt;
  try {
    const found = await withYoomoneyToken(scope, (token) =>
      findYoomoneyPayment(token, {
        amountMinor: payment.amountMinor,
        label: payment.kind === "transfer" ? payment.id : undefined,
        patternId: payment.requestParams.pattern_id,
        since: new Date(sent.getTime() - 60_000),
      })
    );
    if (!found.connected) return undefined;
    switch (found.result.kind) {
      case "paid":
        return {
          state: "paid" as const,
          paymentId: found.result.operationId,
        };
      case "refused":
        return { state: "refused" as const, error: "payment_refused" };
      case "pending":
        return { state: "pending" as const };
      case "absent":
        return sent.getTime() <
          Date.now() - (payment.bankUri === null ? 30 : 60) * 60_000
          ? { state: "refused" as const, error: "not_in_history" }
          : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
