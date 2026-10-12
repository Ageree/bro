import { defineSchedule } from "eve/schedules";
import { sendOwnerDigest } from "@agent/lib/monitoring/digest";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { expireTurnLog } from "@db/services/turn-log";
import { env } from "@shared/environment";

// Once an hour, the owner's turn log loses the text older than
// OWNER_TRANSCRIPTS_RETENTION_DAYS and the turns older than 180 days, and
// in OWNER_DIGEST_HOUR (Moscow) the owner gets the day's summary. The sweep
// runs under EVE_SCHEDULES=off too: the retention is a promise to people,
// and a delete of what expired is harmless wherever it runs. The summary
// does not: a stand would tell the owner about a copy of production's day.
export default defineSchedule({
  cron: "7 * * * *",
  run({ waitUntil }) {
    waitUntil(
      runPass("expire", () =>
        expireTurnLog(env.OWNER_TRANSCRIPTS_RETENTION_DAYS)
      )
    );
    if (!schedulesEnabled()) return;
    waitUntil(
      runPass("digest", async () => {
        await sendOwnerDigest();
      })
    );
  },
});

/**
 * eve settles a schedule's background work without looking at the result:
 * a failed pass is logged here, by the error's name only — drizzle's
 * message quotes the query's parameters.
 */
async function runPass(pass: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    console.error("[owner-digest] pass failed", {
      cause: error instanceof Error ? error.name : "unknown",
      pass,
    });
  }
}
