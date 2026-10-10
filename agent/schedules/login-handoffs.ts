import { defineSchedule } from "eve/schedules";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { deliverLoginHandoffReports } from "@agent/lib/login-handoff/deliver";
import { loginHandoffOn } from "@agent/lib/login-handoff/pilot";
import { settleLoginHandoffs } from "@agent/lib/login-handoff/settle";
import { env } from "@shared/environment";

// Each minute: a link nobody opened expires, a sign-in whose viewer went away
// is read off its browser and ended, and the report of each end goes to the
// conversation the link was asked for in (docs/login-handoff.md). Switched
// off (LOGIN_HANDOFF_WORKSPACES=off), the tick does nothing.
export default defineSchedule({
  cron: "* * * * *",
  run({ attachSession, to, waitUntil }) {
    if (!schedulesEnabled()) return;
    if (!loginHandoffOn()) return;
    if (env.DATABASE_DRIVER === "neon-http") return;
    waitUntil(tick({ attachSession, to }));
  },
});

/**
 * eve settles a schedule's background work without looking at the result, so
 * a tick that failed would otherwise leave no trace at all.
 */
async function tick(
  delivery: Parameters<typeof deliverLoginHandoffReports>[0]
) {
  try {
    await settleLoginHandoffs();
    await deliverLoginHandoffReports(delivery);
  } catch (error) {
    console.warn("[login-handoff] the tick failed", { cause: error });
  }
}
