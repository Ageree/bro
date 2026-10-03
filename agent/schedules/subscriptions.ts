import { defineSchedule } from "eve/schedules";
import { within } from "@agent/lib/browser-use/deadline";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { flightReminderKey } from "@agent/lib/proactive/signals";
import { judgePriceCheck } from "@agent/lib/subscriptions/check";
import { flightPlan, measureDrive } from "@agent/lib/subscriptions/flight";
import { readPricePage } from "@agent/lib/subscriptions/page";
import { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import { flightWatchOf, priceWatchOf } from "@agent/lib/subscriptions/watches";
import {
  filterUnseenProactiveSignals,
  queueProactiveRun,
} from "@db/services/proactive";
import {
  type ClaimedSubscription,
  type SubscriptionCheck,
  claimDueSubscriptions,
  settleFlightWatch,
  settleSubscriptionCheck,
} from "@db/services/subscriptions";
import {
  readProactiveMessages,
  readUserProfile,
} from "@db/services/user-profile";
import { resolveTimeZone } from "@shared/user-profile/schema";

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
/** How long measuring a flight's drive may take within a tick. */
const driveTimeoutMs = 20_000;
/** When another proactive run is open, a flight's reminder tries again. */
const busyRetryMs = 5 * 60_000;
/**
 * The proactive job's daily cap; a flight's reminder is a calendar run,
 * which passes it (`queueProactiveRun`).
 */
const proactiveRunsPerDay = 12;

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
  const url = priceWatchOf(subscription)?.source.url;
  return (url && URL.parse(url)?.hostname) ?? subscription.id;
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
 * A watch outside the pilot (SUBSCRIPTIONS_WORKSPACES taken back, or a
 * lookup that failed) is held: nothing is read and nothing is sent, and one
 * whose term ran out ends quietly. Back in the pilot, it goes on from where
 * it was. Undefined for a watch of the pilot.
 */
async function heldCheck(
  subscription: ClaimedSubscription,
  now: Date
): Promise<SubscriptionCheck | undefined> {
  const inPilot = await subscriptionsPilot({
    userId: subscription.createdByUserId,
    workspaceId: subscription.workspaceId,
  });
  if (inPilot) return undefined;
  return subscription.expiresAt.getTime() <= now.getTime()
    ? { kind: "lapsed" }
    : {
        kind: "held",
        nextCheckAt: new Date(
          now.getTime() + subscription.checkEverySeconds * 1_000
        ),
      };
}

/** A price watch's check: the page read by code, judged by code. */
async function checkPrice(subscription: ClaimedSubscription) {
  const now = new Date();
  const held = await heldCheck(subscription, now);
  if (held) return { check: held, outcome: await settle(subscription, held) };
  const watch = priceWatchOf(subscription);
  // A row whose JSON no longer reads as a price watch ends without a word.
  const check: SubscriptionCheck = watch
    ? judgePriceCheck(
        watch,
        watch.expiresAt.getTime() <= now.getTime()
          ? { kind: "no-price" }
          : await readSafely(watch.source.url),
        new Date()
      )
    : { kind: "lapsed" };
  return { check, outcome: await settle(subscription, check) };
}

function settle(subscription: ClaimedSubscription, check: SubscriptionCheck) {
  return settleSubscriptionCheck(subscription, check);
}

/**
 * A flight's check. The reminders due now (`flightPlan`) go to one run of
 * the proactive worker with the facts counted by code; a reminder an
 * earlier run was handed (the proactive check's own, before the pilot) is
 * not handed again. Another open run puts it off by a few minutes; a person
 * who turned proactive messages off is owed none. The watch ends once no
 * reminder is ahead.
 */
async function checkFlight(subscription: ClaimedSubscription) {
  const now = new Date();
  const held = await heldCheck(subscription, now);
  if (held) return { outcome: await settle(subscription, held) };
  const watch = flightWatchOf(subscription);
  if (!watch) {
    return {
      outcome: await settleFlightWatch(subscription, {
        kind: "ended",
        status: "failed",
      }),
    };
  }
  const scope = {
    userId: watch.createdByUserId,
    workspaceId: watch.workspaceId,
  };
  const [profile, proactive] = await Promise.all([
    readUserProfile(scope),
    readProactiveMessages(scope),
  ]);
  const timeZone = resolveTimeZone(profile.timezone);
  const departure = new Date(watch.source.start);
  const { due } = flightPlan({
    departure,
    done: watch.state.done,
    now,
    timeZone,
  });
  let state = watch.state;
  if (due.length > 0 && proactive) {
    if (state.travel === undefined) {
      state = {
        ...state,
        travel: await measureDrive(
          watch,
          profile,
          AbortSignal.timeout(driveTimeoutMs)
        ),
      };
    }
    const signals = await filterUnseenProactiveSignals(
      watch.workspaceId,
      due.map((stage) => ({
        dedupeKey: flightReminderKey(
          watch.source.eventId,
          watch.source.start,
          stage
        ),
        itemId: watch.source.eventId,
        source: "calendar" as const,
        threadId: null,
      }))
    );
    if (signals.length > 0) {
      const queued = await queueProactiveRun({
        jobId: watch.jobId,
        maxRunsPerDay: proactiveRunsPerDay,
        now,
        signals,
        workspaceId: watch.workspaceId,
      });
      if (queued.status !== "queued") {
        return {
          due,
          outcome: await settleFlightWatch(watch, {
            kind: "next",
            nextCheckAt: new Date(now.getTime() + busyRetryMs),
            state,
          }),
        };
      }
    }
  }
  state = { ...state, done: [...state.done, ...due] };
  const { next } = flightPlan({ departure, done: state.done, now, timeZone });
  return {
    due,
    outcome: await settleFlightWatch(
      watch,
      next
        ? { kind: "next", nextCheckAt: next, state }
        : {
            kind: "ended",
            state,
            status: state.done.length > 0 ? "fired" : "expired",
          }
    ),
  };
}

/** One check, logged as one line with its outcome and never the page. */
async function checkSubscription(subscription: ClaimedSubscription) {
  const logged = {
    subscriptionId: subscription.id,
    template: subscription.template,
    workspaceId: subscription.workspaceId,
  };
  try {
    if (subscription.template === "flight") {
      const { due, outcome } = await checkFlight(subscription);
      console.info("[subscriptions] check", {
        ...logged,
        outcome: outcome ?? "lease_lost",
        ...(due && due.length > 0 && { due }),
      });
      return;
    }
    const { check, outcome } = await checkPrice(subscription);
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
