import { defineSchedule } from "eve/schedules";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { tellYoomoneyOutcomes } from "@agent/lib/yoomoney/notice";
import { resumeYoomoneyOnboardings } from "@agent/lib/yoomoney/onboarding";
import { readBackYoomoneyPayments } from "@db/services/yoomoney/settle";
import { env } from "@shared/environment";
import { yoomoneyConfigured } from "@shared/yoomoney/api";

// Each minute: wallet payments in flight that nobody asks about — one
// YooMoney is still processing, an answer that was lost, a card payment
// whose person never came back from the bank — are read back with their
// own `request_id` and the wallet's history, and a payment that settled
// where Bro did not see it is told in the chat it was asked in. Without
// this, such a payment waited for the person to ask and kept every next
// payment of the workspace waiting behind it. A wallet the person just
// connected from a chat (the onboarding page) is told in that chat, where
// Bro carries on with what they asked to pay.
export default defineSchedule({
  cron: "* * * * *",
  run({ attachSession, to, waitUntil }) {
    if (!schedulesEnabled() || !yoomoneyConfigured()) return;
    if (env.DATABASE_DRIVER === "neon-http") return;
    waitUntil(tick({ attachSession, to }));
  },
});

/**
 * eve settles a schedule's background work without looking at the result, so
 * a tick that failed would otherwise leave no trace at all.
 */
async function tick(delivery: Parameters<typeof resumeYoomoneyOnboardings>[0]) {
  try {
    await readBackYoomoneyPayments(new Date());
  } catch (error) {
    console.warn("[yoomoney] the read back tick failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
  try {
    await tellYoomoneyOutcomes(delivery, new Date());
  } catch (error) {
    console.warn("[yoomoney] the outcome tick failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
  try {
    await resumeYoomoneyOnboardings(delivery, new Date());
  } catch (error) {
    console.warn("[yoomoney] the onboarding tick failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
}
