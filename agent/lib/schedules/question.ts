import type { ModelMessage } from "ai";
import { z } from "zod";
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

const taggedMessageSchema = z.object({ kind: z.string() });

/**
 * Whether a turn-starting message is one the person wrote: not a background
 * wakeup, and not a prompt Bro wrote to itself, such as a scheduled report or
 * a browser run's result.
 */
function writtenByPerson(message: ModelMessage, text: string) {
  const kind = taggedMessageSchema.safeParse(message).data?.kind ?? "user";
  return kind === "user" && !isBackgroundTurnText(text);
}

/**
 * The scheduled runs whose question the person's latest message may be
 * replying to: a report turn delivered it to them after their previous
 * message and before this one. Only an answer to one of these can be the
 * person's answer. In the benchmark a turn about something else resumed an
 * old run with a reply the model made up; a question that never reached this
 * chat has nobody here to answer it, and one the person already wrote past
 * without answering is theirs to come back to, not the model's to settle.
 */
export function answerableScheduledQuestions(
  messages: readonly ModelMessage[]
) {
  let sincePersonWrote = new Set<string>();
  let answerable = new Set<string>();
  let asking: string | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      if (!startsTurn(message)) continue;
      const text = messageText(message);
      if (writtenByPerson(message, text)) {
        answerable = sincePersonWrote;
        sincePersonWrote = new Set();
        asking = undefined;
      } else {
        asking = scheduledQuestionRunId(text);
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
    if (delivered) sincePersonWrote.add(asking);
  }
  return [...answerable];
}
