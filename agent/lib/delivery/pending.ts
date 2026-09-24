import type { ModelMessage } from "ai";
import { z } from "zod";
import { sendReachedPerson } from "./turn-sends";

/** Tools whose successful call is the reply a person actually sees. */
const deliveryToolNames = new Set(["send_message", "react_to_message"]);

/**
 * eve tags every user-role message it keeps in history with a kind: `user`
 * for what a person wrote, and framework kinds for context, retries, and
 * background wakeups. The tag is not part of the AI SDK message type.
 */
const taggedMessageSchema = z.object({ kind: z.string() });

function userMessageKind(message: ModelMessage) {
  return taggedMessageSchema.safeParse(message).data?.kind ?? "user";
}

/**
 * A send `send_message` dropped or returned for a rewrite completes too, but
 * nobody received it, so the person is still waiting.
 */
function deliveredByTool(message: ModelMessage) {
  return (
    message.role === "tool" &&
    message.content.some(
      (part) =>
        part.type === "tool-result" &&
        deliveryToolNames.has(part.toolName) &&
        sendReachedPerson(part.output)
    )
  );
}

/**
 * Model steps a turn may spend on other tools before delivery stops being
 * forced. eve has no per-turn step limit, so a model that will not reply
 * would otherwise keep calling tools until the session budget ran out; past
 * this point it may end in text again and the channel fallback delivers it.
 */
const forcedStepLimit = 10;

/**
 * Whether the latest message a person wrote is still waiting for a
 * `send_message` or `react_to_message` that went through. A wakeup from a
 * finished background task is not a person talking, and the instructions let
 * the model keep such a wakeup silent, so it never counts as waiting.
 */
export function awaitsDelivery(messages: readonly ModelMessage[]) {
  let steps = 0;
  for (const message of messages.toReversed()) {
    if (deliveredByTool(message)) return false;
    if (message.role === "assistant") steps += 1;
    if (message.role !== "user") continue;
    const kind = userMessageKind(message);
    if (kind === "user") return steps < forcedStepLimit;
    if (kind === "execution.background_task") return false;
  }
  return false;
}
