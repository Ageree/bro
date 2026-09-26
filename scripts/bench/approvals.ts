import type { InputRequest, InputResponse } from "eve/client";
import { z } from "zod";

/**
 * How the driver answers Bro's approval cards, by the benchmark's rules: a
 * payment, booking, sign-up, application, or a message to someone else is
 * never approved (the run only has to reach the confirmation step), so those
 * cards get «Cancel». What changes only the tester's own things — an event in
 * their own calendar with nobody invited, a task in their own Notion — is
 * approved, because tests such as «Регулярные задачи» score the result.
 *
 * Questions are not answered: the answer is the tester's, and an invented
 * one would be a hint. The driver stops and says how to reply.
 *
 * A card of a tool named by `--hold` is not answered either, even where it
 * would otherwise be cancelled: real purchases against prod (`u8`) need the
 * owner to decide the payment card himself, so the driver stops on it too
 * and leaves it for `pnpm bench send --option approve|cancel`.
 *
 * `--confirm-payment-up-to` is the owner's standing decision (26.09): the
 * driver may confirm a payment card up to that many roubles on his behalf,
 * cancelling anything above it or without a known charge. This only reads
 * `submission.chargeRub` off an `allowPayment` card — the same field
 * `shared/chat/approval-card.ts` draws the card's payment line from — so it
 * is not specific to `browser_task`, but no other tool sets it today. It
 * does not touch a plain-text confirmation (a `question` request, or Bro
 * simply asking in a message): that path stays for the tester, unhandled
 * here until the planned text confirmation lands.
 */

/**
 * Tools whose approval only touches the tester's own data. An event update is
 * not one of them: its card carries only the changed fields, and Google mails
 * the event's existing guests about the change, whom the card never shows.
 */
export const ownDataTools: readonly string[] = [
  "calendar-create-event",
  "notion-add-task",
];

// An invitation mails the attendees, which makes the event a message to
// someone else.
const invitesSomeoneSchema = z.object({
  attendees: z.array(z.unknown()).min(1),
});

// The same shape `shared/chat/approval-card.ts` reads a payment line from:
// `allowPayment` marks the card as a payment confirmation, and
// `submission.chargeRub` carries its amount (set by `browser_task` today,
// but not tied to it).
const paymentCardSchema = z
  .object({
    allowPayment: z.boolean(),
    submission: z.object({ chargeRub: z.number().nonnegative() }).partial(),
  })
  .partial();

function paymentCapDecision(
  request: InputRequest,
  capRub: number
): InputDecision | undefined {
  const card = paymentCardSchema.safeParse(request.action.input);
  if (!card.success || card.data.allowPayment !== true) return undefined;
  const chargeRub = card.data.submission?.chargeRub;
  const withinCap = chargeRub !== undefined && chargeRub <= capRub;
  const amountText =
    chargeRub === undefined
      ? "сумма неизвестна"
      : `${String(chargeRub)} ₽ ${withinCap ? "≤" : ">"} лимита ${String(capRub)} ₽`;
  return {
    kind: "respond",
    reason: `оплата (--confirm-payment-up-to): ${amountText} — ${withinCap ? "подтверждаем от имени владельца" : "отклоняем"}`,
    response: {
      optionId: withinCap ? "approve" : "cancel",
      requestId: request.requestId,
    },
  };
}

export type InputDecision =
  | {
      readonly kind: "respond";
      readonly reason: string;
      readonly response: InputResponse;
    }
  | { readonly kind: "ask-tester"; readonly reason: string };

export function decideInputRequest(
  request: InputRequest,
  approvedTools: readonly string[],
  heldTools: readonly string[] = [],
  confirmPaymentUpToRub?: number
): InputDecision {
  if (request.kind === "question") {
    return {
      kind: "ask-tester",
      reason:
        "вопрос к тестировщику: ответ даёт человек через `pnpm bench send`",
    };
  }
  if (request.kind === "session-limit") {
    return {
      kind: "respond",
      reason: "длинный ход продолжается, как продолжил бы человек",
      response: { optionId: "continue", requestId: request.requestId },
    };
  }
  const tool = request.action.toolName;
  if (heldTools.includes(tool)) {
    return {
      kind: "ask-tester",
      reason: `карточка «${tool}» на удержании (--hold): ответ даёт владелец через \`pnpm bench send --option approve|cancel\``,
    };
  }
  if (confirmPaymentUpToRub !== undefined) {
    const decision = paymentCapDecision(request, confirmPaymentUpToRub);
    if (decision) return decision;
  }
  const approve =
    approvedTools.includes(tool) &&
    !invitesSomeoneSchema.safeParse(request.action.input).success;
  return {
    kind: "respond",
    reason: approve
      ? `меняет только данные тестировщика (${tool})`
      : `по правилам прогона карточки «${tool}» отклоняются`,
    response: {
      optionId: approve ? "approve" : "cancel",
      requestId: request.requestId,
    },
  };
}

/**
 * The reply to a pending request from what the tester typed: the option
 * whose id or label matches, otherwise free text where the card allows it.
 */
export function responseFromText(
  request: InputRequest,
  text: string
): InputResponse {
  const wanted = text.trim().toLowerCase();
  const option = request.options?.find(
    (candidate) =>
      candidate.id.toLowerCase() === wanted ||
      candidate.label.toLowerCase() === wanted
  );
  if (option) return { optionId: option.id, requestId: request.requestId };
  if (request.allowFreeform !== false && request.kind === "question") {
    return { requestId: request.requestId, text };
  }
  const choices = (request.options ?? [])
    .map((candidate) => `${candidate.id} («${candidate.label}»)`)
    .join(", ");
  throw new Error(
    `The card ${request.requestId} takes one of: ${choices || "no options"}.`
  );
}
