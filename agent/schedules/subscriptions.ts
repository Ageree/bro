import { defineSchedule } from "eve/schedules";
import { within } from "@agent/lib/browser-use/deadline";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { judgePriceCheck } from "@agent/lib/subscriptions/check";
import { readPricePage } from "@agent/lib/subscriptions/page";
import { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import {
  type ClaimedSubscription,
  type SubscriptionCheck,
  claimDueSubscriptions,
  settleSubscriptionCheck,
} from "@db/services/subscriptions";

/**
 * A check's lease. Each page read is bounded (`downloadWithin`), and a tick
 * stops waiting long before the lease runs out, so a lease never ends with
 * its check still going.
 */
const leaseForMs = 10 * 60_000;
/**
 * How long one tick starts checks for. A read in flight takes at most 90 s
 * (15 s a hop, five redirects), so the last one ends before the next tick:
 * no shop is read by two ticks at once.
 */
const tickDeadlineMs = 3 * 60_000;
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
    const stopAt = now.getTime() + tickDeadlineMs;
    const finished = await within(
      Promise.all(byHost(due).map(async (group) => checkInTurn(group, stopAt))),
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

/**
 * One shop's watches, one request at a time. Past the tick's deadline the
 * rest are left to their lease, so a slow shop is never read by two ticks
 * at once.
 */
async function checkInTurn(
  group: readonly ClaimedSubscription[],
  stopAt: number
) {
  for (const subscription of group) {
    if (Date.now() >= stopAt) return;
    // oxlint-disable-next-line eslint/no-await-in-loop -- One request at a time to the same shop.
    await checkSubscription(subscription);
  }
}

/**
 * The check a watch gets. Outside the pilot (SUBSCRIPTIONS_WORKSPACES taken
 * back, or a lookup that failed) it is held: no page is read, no news is
 * sent, and one whose term ran out ends quietly. Back in the pilot, it goes
 * on from where it was.
 */
async function decideCheck(
  subscription: ClaimedSubscription
): Promise<SubscriptionCheck> {
  const now = new Date();
  const expired = subscription.expiresAt.getTime() <= now.getTime();
  const inPilot = await subscriptionsPilot({
    userId: subscription.createdByUserId,
    workspaceId: subscription.workspaceId,
  });
  if (!inPilot) {
    return expired
      ? { kind: "lapsed" }
      : {
          kind: "held",
          nextCheckAt: new Date(
            now.getTime() + subscription.checkEverySeconds * 1_000
          ),
        };
  }
  const reading = expired
    ? ({ kind: "no-price" } as const)
    : await readSafely(subscription.source.url);
  return judgePriceCheck(subscription, reading, new Date());
}

/** One check, logged as one line with its outcome and never the page. */
async function checkSubscription(subscription: ClaimedSubscription) {
  const logged = {
    subscriptionId: subscription.id,
    template: subscription.template,
    workspaceId: subscription.workspaceId,
  };
  try {
    const check = await decideCheck(subscription);
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

/**
 * A page read that cannot throw: a stored link that no longer parses or a
 * read that failed in a way the download did not foresee counts as a failed
 * check, so the backoff and the third failure's report still apply.
 */
async function readSafely(url: string) {
  try {
    return await readPricePage(new URL(url));
  } catch (error) {
    return {
      kind: "unreachable" as const,
      reason: error instanceof Error ? error.name : "error",
    };
  }
}
