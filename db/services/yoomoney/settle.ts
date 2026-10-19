import type { yoomoneyPayments } from "@db";
import type { AccessScope } from "@shared/identity/access-scope";
import { YoomoneyError } from "@shared/yoomoney/api";
import {
  processYoomoneyPayment,
  yoomoneyReadBackSilent,
} from "@shared/yoomoney/payments";
import { readYoomoneyConnection, withYoomoneyToken } from "./connection";
import { settlementFromHistory } from "./history";
import {
  readYoomoneyPayment,
  settleYoomoneyPayment,
  yoomoneyPaymentsToReadBack,
} from "./payments";

/**
 * Where a payment from the wallet goes once claimed, and how one in flight
 * is read back: by `yoomoney_pay` (`agent/tools/yoomoney_pay.ts`) and, each
 * minute, by the tick that settles what nobody asked about
 * (`agent/schedules/yoomoney.ts`). A payment that may have gone through is
 * only read back with its own `request_id`, never paid again.
 */

type Payment = typeof yoomoneyPayments.$inferSelect;

type Settlement = Omit<
  Parameters<typeof settleYoomoneyPayment>[1],
  "id" | "from"
>;

type From = Parameters<typeof settleYoomoneyPayment>[1]["from"];

/**
 * `process-payment` until YooMoney says paid or refused, a few seconds at
 * most: an `in_progress` payment is asked about again with the same
 * `request_id`, which never pays twice. A card payment is only read back
 * here, by its `request_id` alone: it is paid on its page.
 */
async function pay(token: string, payment: Payment) {
  // A card payment YooMoney has answered: never a new source for it.
  const source =
    payment.cardId === null
      ? { kind: "wallet" as const }
      : { kind: "again" as const };
  let outcome = await processYoomoneyPayment(token, payment.requestId, source);
  for (
    let attempt = 0;
    attempt < 3 && outcome.kind === "pending";
    attempt += 1
  ) {
    const wait = Math.min(outcome.nextRetryMs, 5_000);
    // oxlint-disable-next-line eslint/no-await-in-loop -- YooMoney asks to wait before asking again.
    await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the same request, read back.
      outcome = await processYoomoneyPayment(token, payment.requestId, source);
    } catch (error) {
      // YooMoney took the payment already: a lost or refused read of it
      // says nothing of how it went.
      if (error instanceof YoomoneyError)
        return { kind: "pending" as const, nextRetryMs: 5_000 };
      throw error;
    }
  }
  return outcome;
}

/**
 * A card call YooMoney may never have taken (`unknown`, or `submitting`
 * that long): the history alone says what became of it. A bare
 * `request_id` would make it a first call, and YooMoney's first call with
 * no source pays from the balance.
 */
const cardUnanswered = (payment: Payment) =>
  payment.cardId !== null && payment.state !== "pending";

/** Whether the wallet connected now is the one the payment was prepared from. */
export async function sameYoomoneyWallet(
  scope: AccessScope,
  payment: Pick<Payment, "account">
) {
  const connection = await readYoomoneyConnection(scope);
  return (
    connection.state === "connected" &&
    (payment.account === null || connection.account === payment.account)
  );
}

async function settled(
  scope: AccessScope,
  payment: Payment,
  from: From,
  settlement: Settlement
) {
  const stored =
    (await settleYoomoneyPayment(scope, {
      id: payment.id,
      from,
      ...settlement,
    }).catch(() => undefined)) ??
    // Another reader settled it first: what it wrote stands.
    (await readYoomoneyPayment(scope, { id: payment.id }).catch(
      () => undefined
    ));
  return stored === undefined
    ? { kind: "lost" as const }
    : { kind: "settled" as const, payment: stored };
}

/**
 * Pays a claimed payment, or reads back one in flight (`readBack`), under
 * the wallet's token and settles it from `from`: `settled` with the payment
 * as it now stands. A lost answer is `unknown`; a claimed payment without
 * its wallet is not paid. `unreadable`: one read back whose wallet is not
 * connected now, or is another one, stays as it is — whether it went
 * through is not known. `lost`: the outcome could not be stored or read.
 */
export async function payYoomoneyAndSettle(
  scope: AccessScope,
  payment: Payment,
  { from, readBack }: { readonly from: From; readonly readBack: boolean }
) {
  let settlement: Settlement | undefined;
  try {
    // Another wallet connected since knows nothing of this payment.
    if (readBack && !(await sameYoomoneyWallet(scope, payment))) {
      throw new YoomoneyError("revoked");
    }
    if (readBack && cardUnanswered(payment)) {
      return await settled(
        scope,
        payment,
        from,
        (await settlementFromHistory(scope, payment)) ?? { state: "unknown" }
      );
    }
    const paid = await withYoomoneyToken(scope, (token) => pay(token, payment));
    const outcome = paid.connected
      ? paid.result
      : { kind: "refused" as const, error: "not_connected" };
    if (outcome.kind === "paid") {
      settlement = { state: "paid", paymentId: outcome.paymentId };
    } else if (outcome.kind === "bank") {
      // The bank asks again: its fresh form replaces the stale one.
      settlement = {
        state: "pending",
        bankUri: outcome.acsUri,
        bankParams: outcome.acsParams,
      };
    } else if (outcome.kind === "pending") {
      settlement = { state: "pending" };
    } else if (readBack && outcome.error === "not_connected") {
      settlement = undefined;
    } else if (readBack && yoomoneyReadBackSilent(outcome.error)) {
      // A request read back after its answer was lost may be gone, and a
      // card payment read back while the person is at their bank is not
      // answered yet: neither says whether it was paid, the history may.
      // One YooMoney took (`pending`) stays so, its bank form with it.
      settlement = (await settlementFromHistory(scope, payment)) ?? {
        state: payment.state === "pending" ? "pending" : "unknown",
      };
    } else {
      settlement = { state: "refused", error: outcome.error };
    }
  } catch (error) {
    // A wallet Bro can no longer reach under its token.
    const walletGone =
      error instanceof YoomoneyError &&
      (error.code === "revoked" || error.code === "scope");
    // A lost read of a payment YooMoney took changes nothing: as `unknown`
    // a card payment would only be looked up in the history, never asked
    // about again, and its page would drop the bank's form.
    if (!walletGone)
      settlement = {
        state: readBack && payment.state === "pending" ? "pending" : "unknown",
      };
    else if (!readBack)
      settlement = { state: "refused", error: "not_connected" };
  }
  if (settlement === undefined) return { kind: "unreadable" as const };
  return settled(scope, payment, from, settlement);
}

/**
 * The tick's part: each payment in flight that nobody reads back is read
 * back as `status` would, one after another, so YooMoney sees no burst.
 * What it settles is told to the person by its notice
 * (`agent/lib/yoomoney/notice.ts`).
 */
export async function readBackYoomoneyPayments(now: Date) {
  for (const payment of await yoomoneyPaymentsToReadBack(now)) {
    const { state } = payment;
    if (state !== "pending" && state !== "unknown" && state !== "submitting")
      continue;
    const scope = { userId: payment.userId, workspaceId: payment.workspaceId };
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one payment at a time, gently on YooMoney.
      const read = await payYoomoneyAndSettle(scope, payment, {
        from: [state],
        readBack: true,
      });
      const after = read.kind === "settled" ? read.payment.state : read.kind;
      if (after !== state)
        console.info("[yoomoney] payment read back", { state, after });
    } catch (error) {
      console.warn("[yoomoney] payment read back failed", {
        state,
        name: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}
