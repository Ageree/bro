import type { ModelMessage } from "ai";
import { currentTurnMessages } from "./turn-sends";

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
