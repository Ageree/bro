import { defineSchedule } from "eve/schedules";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import {
  recordUntrackedMemories,
  trimForgottenMemoryHistory,
} from "@db/services/memory/records";

// Once an hour, memory history catches up: the text of memories gone for
// 30 days is wiped, and so is what a release without history forgot; a
// memory such a release saved gets its first revision. Each pass reads the
// whole table, so it is not the minute tick's (`memory.ts`).
export default defineSchedule({
  cron: "17 * * * *",
  run({ waitUntil }) {
    if (!schedulesEnabled()) return;
    waitUntil(maintainMemoryHistory());
  },
});

/**
 * eve settles a schedule's background work without looking at the result, so
 * a tick that failed would otherwise leave no trace at all.
 */
async function maintainMemoryHistory() {
  try {
    await trimForgottenMemoryHistory();
    await recordUntrackedMemories();
  } catch (error) {
    console.error("[memory-history] tick failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
  }
}
