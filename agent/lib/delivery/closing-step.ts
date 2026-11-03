import type { ModelMessage, ToolResultPart } from "ai";
import { repliedWith } from "./pending";
import { currentTurnMessages } from "./turn-sends";

/** Tools whose successful call is the whole of a person's answer. */
const answerTools = new Set(["send_message", "react_to_message"]);

function toolCallsOf(message: ModelMessage | undefined) {
  return message?.role === "assistant" && Array.isArray(message.content)
    ? message.content.flatMap((part) =>
        part.type === "tool-call" ? [part] : []
      )
    : [];
}

function toolResultsOf(messages: readonly ModelMessage[]): ToolResultPart[] {
  return messages.flatMap((message) =>
    message.role === "tool"
      ? message.content.filter((part) => part.type === "tool-result")
      : []
  );
}

/**
 * Whether the current turn's answer is out and no closing step is left. The
 * step before this one must call only answer tools, each of whose results
 * reached the person as a reply (`repliedWith`: not a heads-up, a dropped or
 * failed send, nor a refusal), and at least one of them a `send_message`: a
 * reaction alone does not answer a question. The step that would only write
 * the closing text, which nobody reads, is then skipped
 * (CLOSING_STEP_SKIP_WORKSPACES, `agent/agent.ts`).
 */
export function answeredAndDone(messages: readonly ModelMessage[]) {
  const turn = currentTurnMessages(messages);
  const last = turn.findLastIndex((message) => message.role === "assistant");
  const calls = toolCallsOf(turn.at(last));
  if (last === -1 || calls.length === 0) return false;
  if (!calls.every((call) => answerTools.has(call.toolName))) return false;
  const results = toolResultsOf(turn.slice(last + 1));
  const replied = calls.every((call) => {
    const result = results.find((part) => part.toolCallId === call.toolCallId);
    return result !== undefined && repliedWith(result);
  });
  return replied && calls.some((call) => call.toolName === "send_message");
}
