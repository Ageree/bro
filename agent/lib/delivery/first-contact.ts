import type { ModelMessage } from "ai";
import { z } from "zod";

const markerOpening = "Пометка `first-contact`";

/**
 * Handed to the model with the first message a workspace ever sent, in any
 * channel (`firstContactContext`). The instructions look for the
 * `first-contact` marker and introduce Bro once, in the language the person
 * wrote in. The marker repeats that the introduction does not answer the
 * message: deepseek-v4.1-flash took the introduction for the reply and left a
 * bare first question unanswered (e2e/chat/first-contact.e2e.ts).
 */
export const firstContactMarker = `${markerOpening}: аккаунт этого человека создан прямо сейчас, это его первое в жизни сообщение, и знакомства ещё не было. Знакомство не заменяет ответ: если в сообщении есть вопрос или дело, после пузырей знакомства в этом же ходе ответь на вопрос или возьмись за дело отдельным сообщением.`;

const taggedMessageSchema = z.object({ kind: z.string() });

function messageText(message: ModelMessage) {
  if (!Array.isArray(message.content)) return message.content;
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * Whether the running turn answers the workspace's very first message: the
 * session carries the `first-contact` marker (eve keeps it as a
 * `context.instruction` message) and the person has written once. The marker
 * stays in the session's history, so a later turn of the same conversation,
 * after a second message from the person, is no longer one.
 */
export function firstContactTurn(messages: readonly ModelMessage[]) {
  let marked = false;
  let personMessages = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const kind = taggedMessageSchema.safeParse(message).data?.kind ?? "user";
    if (kind === "user") personMessages += 1;
    // Only the instruction eve keeps: a person may type the marker too.
    else if (
      kind === "context.instruction" &&
      messageText(message).includes(markerOpening)
    ) {
      marked = true;
    }
  }
  return marked && personMessages <= 1;
}
