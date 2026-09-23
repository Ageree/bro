import type { ModelMessage } from "ai";
import { z } from "zod";

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

function deliveredByTool(message: ModelMessage) {
  return (
    message.role === "tool" &&
    message.content.some(
      (part) =>
        part.type === "tool-result" &&
        deliveryToolNames.has(part.toolName) &&
        !["error-json", "error-text", "execution-denied"].includes(
          part.output.type
        )
    )
  );
}

/**
 * Whether the latest message a person wrote is still waiting for a
 * `send_message` or `react_to_message` that went through. A wakeup from a
 * finished background task is not a person talking, and the instructions let
 * the model keep such a wakeup silent, so it never counts as waiting.
 */
export function awaitsDelivery(messages: readonly ModelMessage[]) {
  for (const message of messages.toReversed()) {
    if (deliveredByTool(message)) return false;
    if (message.role !== "user") continue;
    const kind = userMessageKind(message);
    if (kind === "user") return true;
    if (kind === "execution.background_task") return false;
  }
  return false;
}
