import { defineSchedule } from "eve/schedules";
import { runBroToBroSteps } from "@agent/lib/bro-to-bro/engine";
import { deliverBroReports } from "@agent/lib/bro-to-bro/report";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { env } from "@shared/environment";

/**
 * Bro ↔ Bro's tick: the envoys' steps, the threads past their deadline, and
 * the reports to their owners. A tool that changes a thread wakes the steps
 * at once (`runBroToBroSteps`); this tick picks up whatever a restart lost.
 */
export default defineSchedule({
  cron: "* * * * *",
  run({ attachSession, to, waitUntil }) {
    if (
      !schedulesEnabled() ||
      (env.BRO_TO_BRO_WORKSPACES ?? []).length === 0 ||
      env.DATABASE_DRIVER === "neon-http"
    )
      return;
    waitUntil(
      runBroToBroSteps()
        .then(() => deliverBroReports({ attachSession, to }))
        .catch(() => {
          console.warn("[bro-to-bro] reports unavailable");
        })
    );
  },
});
