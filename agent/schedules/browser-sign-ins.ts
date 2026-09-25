import { defineSchedule } from "eve/schedules";
import { browserUseConfigured } from "@agent/lib/browser-use/client";
import { refreshDueSignIns } from "@agent/lib/browser-use/sign-ins";

// Once an hour, a few of the sites the person signed in to through an errand
// are opened again with the same browser profile and the browser is stopped,
// so the session stays fresh and its renewed cookies are kept. Off with
// `BROWSER_USE_SIGN_IN_REFRESH_DAYS=0`.
export default defineSchedule({
  cron: "23 * * * *",
  run({ waitUntil }) {
    if (!browserUseConfigured()) return;
    waitUntil(keepSignInsAlive());
  },
});

/**
 * eve settles a schedule's background work without looking at the result, so
 * a tick that failed would otherwise leave no trace at all.
 */
async function keepSignInsAlive() {
  try {
    await refreshDueSignIns();
  } catch (error) {
    console.error("[browser-use] sign-in keep-alive failed", { cause: error });
  }
}
