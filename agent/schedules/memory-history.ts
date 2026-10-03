import { defineSchedule } from "eve/schedules";
import { z } from "zod";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { expireConversationLines } from "@db/services/conversation-log";
import {
  recordUntrackedMemories,
  trimForgottenMemoryHistory,
} from "@db/services/memory/records";

// Once an hour, memory history catches up: the text of memories gone for
// 30 days is wiped, and so is what a release without history forgot; a
// memory such a release saved gets its first revision. Each pass reads the
// whole table, so it is not the minute tick's (`memory.ts`).
//
// The cross-channel log loses its lines older than 14 days here, every
// workspace's, in the pilot or not. That pass runs under EVE_SCHEDULES=off
// too: the 14 days are a promise to the person, not an action of Bro's, a
// delete of what expired is harmless wherever it runs, and the log has no
// other sweep (a delete on every logged line cost every turn).
export default defineSchedule({
  cron: "17 * * * *",
  run({ waitUntil }) {
    waitUntil(runPass("conversation-log", expireConversationLines));
    if (!schedulesEnabled()) return;
    waitUntil(maintainMemoryHistory());
  },
});

/**
 * eve settles a schedule's background work without looking at the result, so
 * a pass that failed would otherwise leave no trace at all. The passes are
 * independent: one failing does not hold another to the next hour.
 */
async function maintainMemoryHistory() {
  await runPass("trim", trimForgottenMemoryHistory);
  await runPass("untracked", recordUntrackedMemories);
}

const postgresError = z.object({ code: z.string() });

/**
 * Logs a failed pass by the Postgres error code, never the error itself:
 * drizzle's message carries the query's parameters, and here those are
 * memory text.
 */
async function runPass(pass: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    const cause = postgresError.safeParse(
      error instanceof Error ? error.cause : undefined
    );
    console.error("[memory-history] pass failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
      pass,
      sqlState: cause.success ? cause.data.code : undefined,
    });
  }
}
