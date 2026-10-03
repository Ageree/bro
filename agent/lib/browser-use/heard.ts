import type { ModelMessage } from "ai";
import { settledOutcomeRun } from "@agent/lib/delivery/browser-report";
import { sendReachedPerson } from "@agent/lib/delivery/turn-sends";
import { turnCompaction } from "@agent/lib/compaction/mid-turn";
import { type StepIdentity, turnMemory } from "@agent/lib/turn-kind/step";

/**
 * The runs whose settled outcome `browser_task` handed over in this
 * conversation — `status`, or a `continue` answered with the outcome — with
 * a message reaching the person after it. They have heard it, whether or not
 * the run's own report turn has come yet: its report is marked delivered
 * only once that turn ends, and a turn that failed before any message leaves
 * it to be told again.
 */
function outcomesHeard(messages: readonly ModelMessage[]) {
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

/** The runs each turn's steps found heard so far, on this instance. */
const turnHeard = turnMemory<readonly string[]>();

/**
 * `outcomesHeard` for the step `step`. eve's compaction in the turn may
 * summarize the results that told them (`keepNonToolResultMessages` in
 * `eve/dist/src/harness/compaction.js` keeps none of them), so a compacted
 * turn adds what its earlier steps found on this instance. A run this misses
 * is told once more, never acted on: `status` hands over its outcome again.
 */
export function outcomesHeardThisTurn(
  messages: readonly ModelMessage[],
  step: StepIdentity
) {
  const heard = outcomesHeard(messages);
  const earlier = (turnHeard.get(step) ?? []).filter(
    (runId) => !heard.includes(runId)
  );
  const all = [...heard, ...earlier];
  // Uncompacted, the history is whole: what an earlier run of the session
  // left under the same turn id on this instance goes.
  const whole = turnCompaction(messages, step).compaction === "none";
  turnHeard.set(step, whole ? heard : all);
  return whole ? heard : all;
}
