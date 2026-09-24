import type { ModelMessage } from "ai";
import { z } from "zod";
import { currentTurnMessages, sendReachedPerson } from "./turn-sends";

/**
 * Tools that undo or change something the person has, which a question to
 * them in the same turn puts on hold. On 24.09 (RU d02) Bro asked
 * «Остановить её сейчас или оставить?» about a schedule and deleted it three
 * seconds later, in the same turn, with no answer.
 */
export const actionsHeldForAnswer = [
  "calendar-delete-event",
  "calendar-update-event",
  "profile__remove_memory",
  "schedules-update",
  "workstreams__forget",
] as const;

const sentTextSchema = z.object({ text: z.string() });

/**
 * Whether a message ends a sentence with a question mark. Links go first: a
 * `?` in a query string asks nothing.
 */
function asksSomething(text: string) {
  const prose = text
    .replaceAll(/\]\([^)]*\)/gu, "]")
    .replaceAll(/https?:\/\/\S+/giu, " ");
  return /[?？](?=[\s»"')\]]|$)/u.test(prose);
}

/**
 * Whether the current turn put a question to the person in a message that
 * reached them. Their answer comes as their next message, which starts a new
 * turn; until then, what the question was about waits.
 */
export function turnAwaitsAnswer(messages: readonly ModelMessage[]) {
  const turn = currentTurnMessages(messages);
  const delivered = new Set(
    turn.flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-result" &&
            part.toolName === "send_message" &&
            sendReachedPerson(part.output)
              ? [part.toolCallId]
              : []
          )
        : []
    )
  );
  return turn.some(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          part.type === "tool-call" &&
          part.toolName === "send_message" &&
          delivered.has(part.toolCallId) &&
          asksSomething(sentTextSchema.safeParse(part.input).data?.text ?? "")
      )
  );
}

/**
 * Whether the current turn already put an `ask_question` to the person. The
 * answer resumes the same turn rather than starting a new one, so this holds
 * from the question until the person's next own message.
 */
export function turnAskedQuestion(messages: readonly ModelMessage[]) {
  return currentTurnMessages(messages).some(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) => part.type === "tool-call" && part.toolName === "ask_question"
      )
  );
}
