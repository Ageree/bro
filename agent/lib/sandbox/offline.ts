import { defineState } from "eve/context";

/**
 * Why the task agent's model refuses its steps, if it does
 * (`keepOffWebUnlessSent` in `agent/subagents/task/hooks/person-files.ts`):
 * `owed`, its sandbox had to go off the web and could not be marked so, and
 * the next message writes the mark; `unchecked`, a check of whether it has
 * to could not be read, and the next message checks again. Either way the
 * tool router would still let it out, so its model refuses
 * (`agent/subagents/task/agent.ts`) until a later message settles it. Kept
 * in eve's durable session state, which both the hook and the model's
 * resolver read; the state's name and its `owed` stay as live sessions
 * stored them.
 */
const refusal = defineState<{
  readonly owed: boolean;
  readonly unchecked?: boolean;
}>("bro.task-offline-owed", () => ({ owed: false }));

/** What a message's checks left the task agent: free, a mark owed, unchecked. */
type OfflineRefusal = "none" | "owed" | "unchecked";

/** The refusal the last message left. */
export function offlineRefusal(): OfflineRefusal {
  try {
    const { owed, unchecked } = refusal.get();
    return owed ? "owed" : unchecked === true ? "unchecked" : "none";
  } catch (error) {
    // Outside eve's context nothing was recorded either.
    console.warn("[task-files] offline state unread", { cause: error });
    return "none";
  }
}

/** Records what the message's checks left. */
export function recordOfflineRefusal(state: OfflineRefusal) {
  try {
    refusal.update(() =>
      state === "unchecked"
        ? { owed: false, unchecked: true }
        : { owed: state === "owed" }
    );
  } catch (error) {
    console.warn("[task-files] offline state not written", { cause: error });
  }
}
