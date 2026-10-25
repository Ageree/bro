import { defineSchedule } from "eve/schedules";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { watchTaxiRides } from "@agent/lib/taxi/watch";
import { env } from "@shared/environment";

// Each minute: a Yandex Go ride Bro booked is read from Yandex while it is
// on, and the person is told in their chat that a car is found, that it is
// time to step out (about two minutes before it is there) and that it is
// there. Without this, a ride booked from a chat was never followed: the
// person heard of the car only when they asked.
export default defineSchedule({
  cron: "* * * * *",
  run({ attachSession, waitUntil }) {
    if (!schedulesEnabled()) return;
    if (env.DATABASE_DRIVER === "neon-http") return;
    waitUntil(tick({ attachSession }));
  },
});

/**
 * eve settles a schedule's background work without looking at the result, so
 * a tick that failed would otherwise leave no trace at all.
 */
async function tick(delivery: Parameters<typeof watchTaxiRides>[0]) {
  try {
    await watchTaxiRides(delivery, new Date());
  } catch (error) {
    console.warn("[taxi] the watch tick failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
}
