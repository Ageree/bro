import { defineSchedule } from "eve/schedules";
import { runBugBotTick } from "@agent/lib/bug-bot/tick";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { env } from "@shared/environment";

// Each minute, the bug-report bot reads its updates for about a minute of
// long polling (agent/lib/bug-bot). Off unless BUG_BOT=on with a bot token of
// its own, and quiet on a stand (EVE_SCHEDULES=off).
export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    if (!schedulesEnabled()) return;
    if (env.BUG_BOT !== "on") return;
    waitUntil(tick());
  },
});

async function tick() {
  try {
    await runBugBotTick();
  } catch (error) {
    console.warn("[bug-bot] the tick failed", { cause: error });
  }
}
