import type { AttachSessionFn } from "eve/channels";
import { sendCodeNotice } from "@agent/lib/delivery/code-notice";
import {
  claimYoomoneyOutcomeNotices,
  releaseYoomoneyOutcomeNotice,
} from "@db/services/yoomoney/payments";
import { yoomoneyRefusal } from "@shared/yoomoney/payments";

type Settled = Awaited<ReturnType<typeof claimYoomoneyOutcomeNotices>>[number];

const rub = (amountMinor: number) =>
  new Intl.NumberFormat("ru-RU", { currency: "RUB", style: "currency" }).format(
    amountMinor / 100
  );

/**
 * How a wallet payment went, as the person reads it in their chat: what,
 * how much and from where, and for a refusal YooMoney's reason. Code's own
 * words: the model may never call a payment paid that YooMoney did not.
 */
export function yoomoneyOutcomeNotice(
  payment: Pick<
    Settled,
    "state" | "title" | "shown" | "amountMinor" | "cardLabel" | "error"
  >
) {
  const details = payment.shown
    .map(({ label, value }) => `${label}: ${value}`)
    .join("; ");
  const what = `${payment.title}${details ? ` (${details})` : ""}`;
  const source =
    payment.cardLabel === null ? "с кошелька" : `с карты ${payment.cardLabel}`;
  return payment.state === "paid"
    ? `Оплатил через ЮMoney: ${what} — ${rub(payment.amountMinor)} ${source}.`
    : `Платёж через ЮMoney не прошёл: ${what} — ${rub(payment.amountMinor)} ${source}. ${yoomoneyRefusal(payment.error ?? "")} Деньги не списаны.`;
}

/**
 * Tells each wallet payment that settled where Bro did not see it — on its
 * page, at the bank, read back by the tick — in the conversation it was
 * asked in, without the model. A notice that did not land is taken again
 * by a later tick, for an hour.
 */
export async function tellYoomoneyOutcomes(
  delivery: { readonly attachSession?: AttachSessionFn },
  now: Date
) {
  const payments = await claimYoomoneyOutcomeNotices(now);
  await Promise.all(
    payments.map(async (payment) => {
      const { conversationChannel, conversationId } = payment;
      if (conversationChannel === null || conversationId === null) return;
      try {
        await sendCodeNotice(
          delivery,
          {
            conversationChannel,
            conversationId,
            workspaceId: payment.workspaceId,
            userId: payment.userId,
            about: { yoomoneyPaymentId: payment.id },
          },
          yoomoneyOutcomeNotice(payment)
        );
        console.info("[yoomoney] outcome told", {
          channel: conversationChannel,
          state: payment.state,
        });
      } catch (error) {
        console.warn("[yoomoney] outcome notice failed", {
          cause: error,
          channel: conversationChannel,
        });
        await releaseYoomoneyOutcomeNotice(payment.id, now);
      }
    })
  );
}
