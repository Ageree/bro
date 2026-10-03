import type { ModelMessage } from "ai";
import { z } from "zod";

/**
 * eve tags every user-role message it keeps in history with a kind: `user`
 * for what a person wrote, framework kinds for the rest. The tag is not part
 * of the AI SDK message type.
 */
const taggedMessageSchema = z.object({ kind: z.string() });

function userMessageKind(message: ModelMessage) {
  return taggedMessageSchema.safeParse(message).data?.kind ?? "user";
}

/**
 * Whether the step that sees `messages` may let eve compact the
 * conversation: they end in the text that opened the turn, which no model
 * step has answered yet. `agent/agent.ts` asks it only at a turn's first
 * step; every other step reports the model's whole window, so eve does not
 * compact inside a turn of the pilot.
 *
 * eve may compact before any model call, and its resumption guard then puts
 * the last plain-text message of the person after the summary
 * (`withResumptionGuard` in `eve/dist/src/harness/compaction.js`): after a
 * trailing tool result, or after the summary when no recent message is
 * kept. Inside a turn that copy reads as a new person's turn to everything
 * that finds a turn by its opening message (`startsTurn`): a second reply,
 * the task agent's report taken for the person's turn with every tool, old
 * words counted as said in this turn, an approval no longer last. Here the
 * guard has nothing to add: the kept messages end in a user message, which
 * it leaves as it is, and when none of them is kept the message it puts
 * after the summary is the last plain-text one — this opener itself.
 *
 * So the opener must be the last message, plain text, and a person's kind.
 * A photo or a file (a list of parts) is not the text the guard looks for,
 * and with no recent message kept it would bring back an older one. Nor
 * may a framework message come last: the task agent's report
 * (`execution.background_task`) is never the guard's message either, and a
 * `context.*` message after the opener could be all the recent part keeps.
 * A tool message last is a step's results or an approval's answer. eve's
 * memory records come off before the split and go back in front of the
 * result (`canonicalizeMemoryRecords` in `maybeCompact`), so those after
 * the opener do not count.
 */
export function compactsAtTurnStart(messages: readonly ModelMessage[]) {
  const last = messages.findLast(
    (message) =>
      message.role !== "user" || !userMessageKind(message).startsWith("memory.")
  );
  return (
    last?.role === "user" &&
    userMessageKind(last) === "user" &&
    !Array.isArray(last.content)
  );
}
