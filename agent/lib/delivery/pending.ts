import type { ModelMessage } from "ai";
import { z } from "zod";
import { settledOutcomeRun } from "./browser-report";
import {
  currentTurnMessages,
  sendReachedPerson,
  startsTurn,
} from "./turn-sends";

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

/**
 * Whether the current turn already got a `send_message` or
 * `react_to_message` through to the person, whoever started it.
 */
export function turnDelivered(messages: readonly ModelMessage[]) {
  return currentTurnMessages(messages).some(deliveredByTool);
}

/**
 * Whether a tool call of the current turn went through. A browser report's
 * turn may end in a quiet `continue` on the errand, and a model with nothing
 * to add after it may come back empty; that ends the turn too.
 */
export function turnActed(messages: readonly ModelMessage[]) {
  return currentTurnMessages(messages).some(
    (message) =>
      message.role === "tool" &&
      message.content.some(
        (part) =>
          part.type === "tool-result" &&
          !part.output.type.startsWith("error") &&
          part.output.type !== "execution-denied"
      )
  );
}

/**
 * Whether an earlier turn of this conversation already told the person how
 * a browser run ended: `browser_task status` handed over its outcome — the
 * person asked «ну что там?» while the run's report still waited behind
 * their turn — and a message got through after it. The report turn that
 * follows would give them the same result a second time.
 */
export function outcomeToldEarlier(
  messages: readonly ModelMessage[],
  runId: string
) {
  const start = messages.findLastIndex(startsTurn);
  let handedOver = false;
  for (const message of start === -1 ? [] : messages.slice(0, start)) {
    if (startsTurn(message)) handedOver = false;
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      if (
        part.toolName === "browser_task" &&
        settledOutcomeRun(part.output) === runId
      ) {
        handedOver = true;
      }
      if (
        handedOver &&
        part.toolName === "send_message" &&
        sendReachedPerson(part.output)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether the current turn has not taken a model step yet. A browser report
 * is made to call a tool on this step only: a model that answered the report
 * with nothing at all failed the turn before the person heard a word, while
 * the steps after it stay free to end quietly (`agent/agent.ts`).
 */
export function turnTookNoStep(messages: readonly ModelMessage[]) {
  return !currentTurnMessages(messages).some(
    (message) => message.role === "assistant"
  );
}
