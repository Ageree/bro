import { defineSchedule } from "eve/schedules";
import { nudgeQuietPeople } from "@agent/lib/capability-nudge/send";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { env } from "@shared/environment";

// Hourly: someone who talked to Bro and went quiet for three days gets one
// plain-text message about a thing Bro can do that they never tried.
export default defineSchedule({
  cron: "17 * * * *",
  run({ attachSession, waitUntil }) {
    if (!schedulesEnabled()) return;
    if (env.DATABASE_DRIVER === "neon-http") return;
    waitUntil(tick({ attachSession }));
  },
});

/** eve settles background work without looking at the result. */
async function tick(delivery: Parameters<typeof nudgeQuietPeople>[0]) {
  try {
    await nudgeQuietPeople(delivery, new Date());
  } catch (error) {
    console.warn("[capabilities] the nudge tick failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
}
