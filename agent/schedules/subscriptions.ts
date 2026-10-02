import { defineSchedule } from "eve/schedules";
import { within } from "@agent/lib/browser-use/deadline";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { judgePriceCheck } from "@agent/lib/subscriptions/check";
import { readPricePage } from "@agent/lib/subscriptions/page";
import {
  type ClaimedSubscription,
  claimDueSubscriptions,
  settleSubscriptionCheck,
} from "@db/services/subscriptions";

/**
 * A check's lease. Each page read is bounded (`downloadWithin`), and a tick
 * stops waiting long before the lease runs out, so a lease never ends with
 * its check still going.
 */
const leaseForMs = 10 * 60_000;
/** How long one tick waits for its checks; the rest finish on their own. */
const tickDeadlineMs = 4 * 60_000;
const claimLimit = 25;

/**
 * The checks of event subscriptions (docs/roadmap.md, 27), every five
 * minutes, by code alone: a watch that finds nothing never reaches a model.
 * Only a hit, a watch that stopped working, or one whose term ended becomes
 * a finished run of its hidden job, which the schedule tick
 * (`agent/schedules/dynamic.ts`) reports to the person. Kept apart from that
 * tick: a slow shop must not hold up the delivery of anything else.
 */
export default defineSchedule({
  cron: "*/5 * * * *",
  run({ waitUntil }) {
    if (!schedulesEnabled()) return;
    waitUntil(runSubscriptionChecks());
  },
});

async function runSubscriptionChecks() {
  try {
    const now = new Date();
    const due = await claimDueSubscriptions({
      leaseForMs,
      limit: claimLimit,
      now,
    });
    if (due.length === 0) return;
    const finished = await within(
      Promise.all(byHost(due).map(checkInTurn)),
      tickDeadlineMs
    );
    if (finished.timedOut) {
      console.warn("[subscriptions] tick deadline passed", {
        claimed: due.length,
      });
    }
  } catch (error) {
    // eve swallows a schedule's background error: say it here.
    console.warn("[subscriptions] tick failed", { cause: error });
  }
}

/**
 * Watches grouped by the shop they read, so one shop gets one request at a
 * time from a tick however many people watch it.
 */
function byHost(due: readonly ClaimedSubscription[]) {
  const groups = new Map<string, ClaimedSubscription[]>();
  for (const subscription of due) {
    const host = hostOf(subscription);
    groups.set(host, [...(groups.get(host) ?? []), subscription]);
  }
  return [...groups.values()];
}

function hostOf(subscription: ClaimedSubscription) {
  return URL.parse(subscription.source.url)?.hostname ?? subscription.id;
}

async function checkInTurn(group: readonly ClaimedSubscription[]) {
  for (const subscription of group) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One request at a time to the same shop.
    await checkSubscription(subscription);
  }
}

/** One check, logged as one line with its outcome and never the page. */
async function checkSubscription(subscription: ClaimedSubscription) {
  const logged = {
    subscriptionId: subscription.id,
    template: subscription.template,
    workspaceId: subscription.workspaceId,
  };
  try {
    const now = new Date();
    const expired = subscription.expiresAt.getTime() <= now.getTime();
    const reading = expired
      ? ({ kind: "no-price" } as const)
      : await readPricePage(new URL(subscription.source.url));
    const check = judgePriceCheck(subscription, reading, new Date());
    const outcome = await settleSubscriptionCheck(subscription, check);
    console.info("[subscriptions] check", {
      ...logged,
      outcome: outcome ?? "lease_lost",
      ...(check.kind === "failed" && { reason: check.error }),
    });
  } catch (error) {
    // The lease runs out and a later tick tries again.
    console.warn("[subscriptions] check", {
      ...logged,
      cause: error,
      outcome: "error",
    });
  }
}
