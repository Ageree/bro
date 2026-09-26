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
  heldTools: readonly string[] = []
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
