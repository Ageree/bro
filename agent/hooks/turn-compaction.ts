import { defineHook } from "eve/hooks";
import {
  recordCompactionCompleted,
  recordMessageReceived,
  recordStepStarted,
  recordTurnStarted,
} from "@agent/lib/compaction/record";

/**
 * Keeps the record of what eve's compaction did to the current turn
 * (`agent/lib/compaction/record.ts`) in the session's durable state — the
 * turn's opening, and whether a compaction wrote a new summary, are read by
 * the steps' model resolver (`recordStepHistory` in `agent/agent.ts`) — for
 * the readers that find a turn by its opening message
 * (`agent/lib/compaction/mid-turn.ts`). A hook runs after eve records the
 * event, and before the dynamic resolvers of the same event. Every writer
 * catches its own failure: a throw here would fail the person's turn.
 */
export default defineHook({
  events: {
    "turn.started"(event) {
      recordTurnStarted(event.data.turnId);
    },
    "message.received"(event) {
      recordMessageReceived(event.data);
    },
    "step.started"(event) {
      recordStepStarted(event.data);
    },
    "compaction.completed"(event) {
      recordCompactionCompleted(event.data.turnId);
    },
  },
});
