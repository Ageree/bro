import { defineState } from "eve/context";

/**
 * A task agent that had to go off the web and could not be marked so
 * (`keepOffWebUnlessSent` in `agent/subagents/task/hooks/person-files.ts`):
 * the tool router would still let it out, so its model refuses every step
 * (`agent/subagents/task/agent.ts`) until a later message writes the mark.
 * Kept in eve's durable session state, which both the hook and the model's
 * resolver read.
 */
const owedMark = defineState<{ readonly owed: boolean }>(
  "bro.task-offline-owed",
  () => ({ owed: false })
);

/** Whether the task agent still owes its sandbox the mark. */
export function offlineOwed() {
  try {
    return owedMark.get().owed;
  } catch (error) {
    // Outside eve's context nothing was recorded either.
    console.warn("[task-files] offline state unread", { cause: error });
    return false;
  }
}

/** Records whether the mark is still owed. */
export function recordOfflineOwed(owed: boolean) {
  try {
    owedMark.update(() => ({ owed }));
  } catch (error) {
    console.warn("[task-files] offline state not written", { cause: error });
  }
}
