import type { ModelMessage } from "ai";
import { settledOutcomeRun } from "@agent/lib/delivery/browser-report";
import { sendReachedPerson } from "@agent/lib/delivery/turn-sends";

/**
 * The runs whose settled outcome `browser_task` handed over in this
 * conversation — `status`, or a `continue` answered with the outcome — with
 * a message reaching the person after it. They have heard it, whether or not
 * the run's own report turn has come yet: its report is marked delivered
 * only once that turn ends, and a turn that failed before any message leaves
 * it to be told again.
 */
export function outcomesHeard(messages: readonly ModelMessage[]) {
  const handedOver = new Set<string>();
  const heard = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      if (part.toolName === "browser_task") {
        const runId = settledOutcomeRun(part.output);
        if (runId !== undefined) handedOver.add(runId);
      } else if (
        part.toolName === "send_message" &&
        sendReachedPerson(part.output)
      ) {
        for (const runId of handedOver) heard.add(runId);
        handedOver.clear();
      }
    }
  }
  return [...heard];
}
