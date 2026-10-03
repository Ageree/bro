import { defineSchedule } from "eve/schedules";
import { runDueMemoryDigests } from "@agent/lib/memory/digest/run";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";

// Once an hour, the daily memory digest of each workspace whose night is
// over (`agent/lib/memory/digest/run.ts`). It opens no conversation and
// never calls the main agent's model; for the pilot
// (MEMORY_DIGEST_WORKSPACES) with a direct provider, it asks its own cheap
// model about memory that changed (`MEMORY_DIGEST_MODEL`, a `memory` cost).
export default defineSchedule({
  cron: "41 * * * *",
  run({ waitUntil }) {
    if (!schedulesEnabled()) return;
    waitUntil(digestMemory());
  },
});

/**
 * eve settles a schedule's background work without looking at the result, so
 * a tick that failed would otherwise leave no trace at all.
 */
async function digestMemory() {
  try {
    await runDueMemoryDigests();
  } catch (error) {
    console.error("[memory-digest] tick failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
  }
}
