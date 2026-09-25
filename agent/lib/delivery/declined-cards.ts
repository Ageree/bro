import type { ModelMessage } from "ai";
import { currentTurnMessages, sendReachedPerson } from "./turn-sends";

/** One part of a message in the conversation: a tool call, a result, text. */
type MessagePart = Extract<ModelMessage["content"], readonly unknown[]>[number];

/**
 * Whether the person declined an approval card of `toolName` in the current
 * turn and no part `settles` has come after it. A policy's own refusal is
 * written as an automatic request and response: nobody saw a card, so nobody
 * declined one.
 */
export function turnDeclinedCard(
  messages: readonly ModelMessage[],
  toolName: string,
  settles: (part: MessagePart) => boolean
) {
  const calls = new Set<string>();
  const cards = new Set<string>();
  let declined = false;
  for (const message of currentTurnMessages(messages)) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (settles(part)) declined = false;
      if (part.type === "tool-call") {
        if (part.toolName === toolName) calls.add(part.toolCallId);
      } else if (part.type === "tool-approval-request") {
        if (calls.has(part.toolCallId) && part.isAutomatic !== true) {
          cards.add(part.approvalId);
        }
      } else if (
        part.type === "tool-approval-response" &&
        cards.has(part.approvalId)
      ) {
        declined = !part.approved;
      }
    }
  }
  return declined;
}

/**
 * Whether the person declined a `browser_task` card in this turn and has not
 * heard back since. eve answers the declined call with «Tool execution was
 * denied», and on 25.09 (RU d15) the reply read «Заявку в барбершоп тоже не
 * удалось запустить: операция была отклонена», as if something had broken.
 */
export function turnDeclinedErrand(messages: readonly ModelMessage[]) {
  return turnDeclinedCard(
    messages,
    "browser_task",
    (part) =>
      part.type === "tool-result" &&
      part.toolName === "send_message" &&
      sendReachedPerson(part.output)
  );
}

/** What the model reads last until it has answered a declined errand card. */
export const declinedErrandNote =
  "The person declined the browser_task approval card: nothing was submitted in their name, and that was their choice, not an error. Do not say it failed, could not be started or was rejected. If the errand's run found options, show them with their prices and links and ask in one question what to change — the time, the place, the option or the price. If nothing was found yet, say plainly that you did not book it and offer in one question to find the options first without booking anything.";
