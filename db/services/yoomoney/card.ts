import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db, yoomoneyPayments } from "@db";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { applicationOrigin } from "@shared/environment/origin";
import { YoomoneyError } from "@shared/yoomoney/api";
import {
  processYoomoneyPayment,
  requestYoomoneyPayment,
  yoomoneyReadBackSilent,
} from "@shared/yoomoney/payments";
import { readYoomoneyConnection, withYoomoneyToken } from "./connection";
import { settlementFromHistory } from "./history";
import {
  claimYoomoneyPayment,
  renewYoomoneyPayment,
  settleYoomoneyPayment,
} from "./payments";

/**
 * A payment from the wallet's linked card (`agent/tools/yoomoney_pay.ts`
 * prepares it). With no CVV to ask, the person's yes in the chat pays it,
 * as a payment from the balance. When YooMoney wants the card's CVV, the
 * person pays it on its own page, `/pay/<id>`, by a link Bro sends: the
 * press of «Оплатить» there, on a page that shows what is paid and how
 * much, is their consent, and the CVV goes from that form straight to
 * YooMoney, never stored or logged. A bank that asks for 3-D Secure takes
 * the person through the same page. The link carries an HMAC of the
 * payment's id: whoever holds it can pay this one payment, as it was
 * prepared, once.
 */

type CardPayment = typeof yoomoneyPayments.$inferSelect;

/** How long a link pays: the person's moment, not a standing order. */
const linkLifetimeMs = 60 * 60_000;

async function linkToken(id: string) {
  const { secretEncryptionKey } = await getInstallationSecrets();
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secretEncryptionKey, "base64"),
      Buffer.alloc(0),
      "bro-yoomoney-card-payment-link",
      32
    )
  );
  return createHmac("sha256", key).update(id).digest("base64url");
}

/** The page where the person pays a card payment: the link Bro sends. */
export async function yoomoneyPayLink(id: string) {
  const url = new URL(`/pay/${id}`, applicationOrigin());
  url.searchParams.set("t", await linkToken(id));
  return url.toString();
}

/**
 * Where the person's bank sends them back after 3-D Secure, passed or not:
 * made before a payment is claimed, so a failure here leaves nothing
 * claimed.
 */
export async function yoomoneyCardReturn(id: string) {
  const back = async (verdict: "ok" | "fail") => {
    const url = new URL(`/api/yoomoney/pay/${id}/return`, applicationOrigin());
    url.searchParams.set("t", await linkToken(id));
    url.searchParams.set("r", verdict);
    return url.toString();
  };
  return { passed: await back("ok"), failed: await back("fail") };
}

/** The card payment this link names, when the link is its own. */
export async function readYoomoneyPaymentByLink(id: string, token: string) {
  if (!z.uuid().safeParse(id).success) return undefined;
  const expected = Buffer.from(await linkToken(id));
  const given = Buffer.from(token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return undefined;
  const [payment] = await db
    .select()
    .from(yoomoneyPayments)
    .where(and(eq(yoomoneyPayments.id, id), isNotNull(yoomoneyPayments.cardId)))
    .limit(1);
  return payment;
}

const scopeOf = (payment: CardPayment) => ({
  userId: payment.userId,
  workspaceId: payment.workspaceId,
});

/** A fresh `request_id` for the same payment, the same sum and card. */
async function renewed(payment: CardPayment) {
  const checked = await withYoomoneyToken(scopeOf(payment), (token) =>
    requestYoomoneyPayment(token, payment.requestParams)
  );
  if (
    !checked.connected ||
    checked.result.kind !== "ready" ||
    checked.result.amountMinor !== payment.amountMinor ||
    checked.result.card?.id !== payment.cardId
  )
    return undefined;
  return renewYoomoneyPayment(scopeOf(payment), {
    id: payment.id,
    rootSessionId: payment.rootSessionId,
    requestId: checked.result.requestId,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
}

/**
 * Sends a claimed card payment (`submitting`) from its card and settles
 * it: after the yes in the chat with no CVV, or the press on its page with
 * one. `bank` is the form for the person's browser to POST to their bank's
 * 3-D Secure page, also kept on the payment for its page; the bank sends
 * them back to the return address.
 */
export async function sendYoomoneyCardPayment(
  payment: CardPayment,
  {
    cardId,
    csc,
    returnTo,
  }: {
    readonly cardId: string;
    readonly csc: string | undefined;
    readonly returnTo: Awaited<ReturnType<typeof yoomoneyCardReturn>>;
  }
) {
  const scope = scopeOf(payment);
  const settle = (
    settlement: Omit<Parameters<typeof settleYoomoneyPayment>[1], "id" | "from">
  ) =>
    settleYoomoneyPayment(scope, {
      id: payment.id,
      from: ["submitting"],
      ...settlement,
    });
  try {
    const paid = await withYoomoneyToken(scope, (accessToken) =>
      processYoomoneyPayment(accessToken, payment.requestId, {
        kind: "card",
        cardId,
        csc,
        returnTo,
      })
    );
    if (!paid.connected) {
      await settle({ state: "refused", error: "not_connected" });
      return { kind: "settled" as const };
    }
    const outcome = paid.result;
    if (outcome.kind === "bank") {
      await settle({
        state: "pending",
        bankUri: outcome.acsUri,
        bankParams: outcome.acsParams,
      });
      return {
        kind: "bank" as const,
        acsUri: outcome.acsUri,
        acsParams: outcome.acsParams,
      };
    }
    await settle(
      outcome.kind === "paid"
        ? { state: "paid", paymentId: outcome.paymentId }
        : outcome.kind === "pending"
          ? { state: "pending" }
          : { state: "refused", error: outcome.error }
    );
  } catch (error) {
    // A wallet Bro can no longer reach was not paid from; any other lost
    // answer may have paid.
    const walletGone =
      error instanceof YoomoneyError &&
      (error.code === "revoked" || error.code === "scope");
    await settle(
      walletGone
        ? { state: "refused", error: "not_connected" }
        : { state: "unknown" }
    );
  }
  return { kind: "settled" as const };
}

/**
 * The person pressed «Оплатить» on the page: the payment is claimed once
 * and sent from its card with the CVV they typed. `settled` means the page
 * shows the payment's state as it now is.
 */
export async function payYoomoneyByCard(
  id: string,
  token: string,
  csc: string | undefined
) {
  let payment = await readYoomoneyPaymentByLink(id, token);
  if (payment?.cardId == null) return { kind: "unavailable" as const };
  if (payment.state !== "quoted") return { kind: "settled" as const };
  if (payment.createdAt.getTime() < Date.now() - linkLifetimeMs)
    return { kind: "expired" as const };
  const askCsc = payment.cscRequired !== false;
  if (askCsc && !/^\d{3,4}$/u.test(csc ?? ""))
    return { kind: "csc_needed" as const };
  const scope = scopeOf(payment);
  const connection = await readYoomoneyConnection(scope);
  if (
    connection.state !== "connected" ||
    connection.account !== payment.account
  )
    return { kind: "wallet_changed" as const };
  if (payment.expiresAt.getTime() <= Date.now()) {
    payment = await renewed(payment);
    if (payment?.cardId == null) return { kind: "changed" as const };
  }
  const { cardId } = payment;
  const returnTo = await yoomoneyCardReturn(payment.id);
  const claimed = await claimYoomoneyPayment(scope, {
    id: payment.id,
    rootSessionId: payment.rootSessionId,
    confirmationQuestion: payment.confirmationQuestion,
    callId: "card-page",
    consentHash: createHash("sha256")
      .update(`card-page:${payment.id}`)
      .digest("hex"),
  });
  if (claimed.kind === "existing") return { kind: "settled" as const };
  if (claimed.kind === "busy") return { kind: "busy" as const };
  if (claimed.kind === "expired") return { kind: "changed" as const };
  if (claimed.kind !== "claimed") return { kind: "unavailable" as const };
  return sendYoomoneyCardPayment(claimed.payment, {
    cardId,
    csc: askCsc ? csc : undefined,
    returnTo,
  });
}

/**
 * A card payment YooMoney answered (`pending`: with the bank or still in
 * progress) read back by its `request_id` alone — after the person's bank
 * sent them back (`back`: whether it says they passed), or when its page
 * checks it again. A read back YooMoney answers without an outcome — the
 * person still at their bank, or a request it no longer knows — is looked
 * up in the wallet's history and otherwise leaves the payment pending: a
 * refusal then would drop the payment the person is confirming. A lost
 * read changes nothing.
 */
export async function readBackYoomoneyCardPayment(
  id: string,
  token: string,
  back: "passed" | "failed" | undefined
) {
  const payment = await readYoomoneyPaymentByLink(id, token);
  // Which way the bank sent the person back: what a payment lost after the
  // bank did. Only by the payment's own link.
  if (payment !== undefined && back !== undefined)
    console.info("[yoomoney] card payment back from the bank", {
      back,
      state: payment.state,
    });
  if (payment?.state !== "pending") return;
  const scope = scopeOf(payment);
  try {
    const read = await withYoomoneyToken(scope, (accessToken) =>
      processYoomoneyPayment(accessToken, payment.requestId, { kind: "again" })
    );
    if (!read.connected) return;
    const outcome = read.result;
    console.info("[yoomoney] card payment read back", {
      back,
      outcome: outcome.kind,
      error: outcome.kind === "refused" ? outcome.error : undefined,
    });
    // Even back from a bank that did not pass the person, a payment YooMoney
    // does not call refused stays pending: another try at the same bank
    // form may have passed. The history settles it, at most in half an hour.
    const settlement =
      outcome.kind === "paid"
        ? { state: "paid" as const, paymentId: outcome.paymentId }
        : outcome.kind !== "refused"
          ? { state: "pending" as const }
          : !yoomoneyReadBackSilent(outcome.error)
            ? { state: "refused" as const, error: outcome.error }
            : ((await settlementFromHistory(scope, payment)) ?? {
                state: "pending" as const,
              });
    // The bank asks again: its fresh form replaces the stale one. Back from
    // the bank, the form is spent: the page no longer offers it.
    const form =
      outcome.kind === "bank"
        ? { bankUri: outcome.acsUri, bankParams: outcome.acsParams }
        : back === undefined
          ? { bankUri: undefined, bankParams: undefined }
          : { bankUri: null, bankParams: null };
    await settleYoomoneyPayment(scope, {
      id: payment.id,
      from: ["pending"],
      ...settlement,
      ...form,
    });
  } catch {
    // Read again later: the page and Bro's status both can.
  }
}
