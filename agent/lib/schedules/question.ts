import type { ModelMessage } from "ai";
import { isBackgroundTurnText } from "@shared/chat/background-turn";
import { sendReachedPerson, startsTurn } from "@agent/lib/delivery/turn-sends";

/** The opening of the report prompt that brings a run's question to a chat. */
export const waitingQuestionHeading =
  "A background scheduled run is waiting for the user before it can continue.";

/** The line of that prompt that names the run, for `schedules-answer`. */
export const internalRunIdLabel = "Internal run ID:";

const runIdPattern = new RegExp(
  `^${internalRunIdLabel} ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
  "imu"
);

function messageText(message: ModelMessage) {
  if (!Array.isArray(message.content)) return message.content;
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * The run whose question a report prompt brings into the conversation, or
 * none for any other message. The prompt is the only place a run id reaches
 * a conversation.
 */
function scheduledQuestionRunId(text: string) {
  if (!isBackgroundTurnText(text) || !text.includes(waitingQuestionHeading)) {
    return undefined;
  }
  return runIdPattern.exec(text)?.[1];
}

/**
 * The scheduled runs whose question this conversation actually put to the
 * person: the report turn that brought it here delivered a message. Only an
 * answer to one of these can be the person's answer — in the benchmark a
 * turn about something else resumed an old run with a reply the model made
 * up, and a question that never reached this chat has nobody here to answer
 * it.
 */
export function shownScheduledQuestions(messages: readonly ModelMessage[]) {
  const shown = new Set<string>();
  let asking: string | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      if (startsTurn(message)) {
        asking = scheduledQuestionRunId(messageText(message));
      }
      continue;
    }
    if (asking === undefined || message.role !== "tool") continue;
    const delivered = message.content.some(
      (part) =>
        part.type === "tool-result" &&
        part.toolName === "send_message" &&
        sendReachedPerson(part.output)
    );
    if (delivered) shown.add(asking);
  }
  return [...shown];
}
