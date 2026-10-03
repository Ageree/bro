import type { ModelMessage } from "ai";
import { compactionOfTurn } from "@agent/lib/compaction/record";
import { compactionMarker } from "@agent/lib/compaction/summary";
import { type StepIdentity, turnMemory } from "@agent/lib/turn-kind/step";

/** The turns whose missing record was already logged on this instance. */
const loggedUnknown = turnMemory<true>();

/**
 * What eve's compaction did to the turn `step` belongs to, for a reader of
 * its history: its durable record (`compactionOfTurn`), whatever earlier
 * turns' summaries the history holds. Only a summary eve wrote leaves a
 * copy of an older message of the person's behind (`withResumptionGuard`
 * after `compactMessages` in `eve/dist/src/harness/compaction.js`), and it
 * always leaves its marker: a history without one is read as it is, as
 * before compaction existed. With a marker and no record of this turn — a
 * turn begun before this code ran, a failed write, a subagent — nothing
 * tells whose summary it is, and the turn is taken as compacted inside, of
 * an unknown kind. `afterInside`, `backgroundTask` and `summaryOpener` are
 * known only from a record.
 */
export function turnCompaction(
  messages: readonly ModelMessage[],
  step: StepIdentity
): NonNullable<ReturnType<typeof compactionOfTurn>> {
  if (!messages.some(compactionMarker)) {
    return {
      afterInside: false,
      backgroundTask: null,
      compaction: "none",
      summaryOpener: null,
    };
  }
  const record = compactionOfTurn(step.turnId, messages);
  if (record !== undefined) return record;
  // A step without a turn id is eve's replay of approved tools between
  // turns (`shouldPrepareApprovalReplayTools`): read as compacted, quietly.
  if (step.turnId !== undefined && loggedUnknown.get(step) === undefined) {
    loggedUnknown.set(step, true);
    console.warn("[compaction] no record of the turn: read as compacted", {
      sessionId: step.sessionId,
      turnId: step.turnId,
    });
  }
  return {
    afterInside: false,
    backgroundTask: null,
    compaction: "inside",
    summaryOpener: null,
  };
}
