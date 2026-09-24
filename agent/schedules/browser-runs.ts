import { defineSchedule } from "eve/schedules";
import {
  BrowserUseError,
  browserUseConfigured,
  readBrowserUseRunStatus,
} from "@agent/lib/browser-use/client";
import {
  maximumCaptchaAttempts,
  startCaptchaRetry,
} from "@agent/lib/browser-use/captcha-retry";
import {
  queueRetryAt,
  startQueuedBrowserRun,
} from "@agent/lib/browser-use/queue";
import { reconcileSpendReservations } from "@agent/lib/browser-use/spend";
import {
  deliverBrowserRunReport,
  expireBrowserRun,
  reportClosedBrowserRun,
  reportWalledBrowserRun,
  settleBrowserRun,
  type BrowserRunDelivery,
} from "@agent/lib/browser-use/completion";
import { alertOwner, clearOwnerAlert } from "@agent/lib/owner-alert";
import {
  claimDueBrowserRunRetries,
  claimNextQueuedBrowserRun,
  listOverdueBrowserRunReports,
  listPendingBrowserRunReports,
  parkBrowserRunForRetry,
  parkQueuedBrowserRun,
  takeUnsettledBrowserRuns,
} from "@db/services/browser-runs";

// A webhook that never arrives must not strand an errand, so every open run is
// reconciled from the cheap status endpoint until it reaches a terminal state.
// The schedule also holds a session handle, which is the only way to reach an
// eve chat, so every conversation gets its report from here without a webhook.
const settleAfterMs = 30_000;
const abandonAfterMs = 45 * 60_000;
const pollLimit = 25;
/**
 * Batches one poll may take. Every open run is checked each minute up to
 * this many; past it, the runs checked longest ago go first next minute.
 */
const maximumPollBatches = 8;
/** Browsers free up one run at a time; a minute seldom frees more. */
const maximumQueueStartsPerPoll = 5;
/** A settled run's report should be in the chat within the minute. */
const reportOverdueAfterMs = 2 * 60_000;
const overdueAlertKey = "browser-use-undelivered-reports";
const overdueAlertRepeatAfterMs = 6 * 60 * 60_000;

export default defineSchedule({
  cron: "* * * * *",
  run({ attachSession, to, waitUntil }) {
    if (!browserUseConfigured()) return;
    waitUntil(reconcileBrowserRuns({ attachSession, to }));
  },
});

async function reconcileBrowserRuns(delivery: BrowserRunDelivery) {
  const now = new Date();
  await reconcileUnsettledBrowserRuns(delivery, now);
  // Errands parked on an anti-bot wall get their next attempt when it is due.
  const retries = await claimDueBrowserRunRetries(now, pollLimit);
  await Promise.all(
    retries.map((retry) => retryWalledBrowserRun(delivery, retry, now))
  );
  // Settling above freed browsers; errands waiting for one start now.
  await drainBrowserQueue(delivery, now);
  await safeReconcileSpend(now);
  // A report still pending here is one whose delivery failed; it is retried
  // every poll until it lands or runs out of attempts.
  const reports = await listPendingBrowserRunReports(pollLimit);
  await Promise.all(
    reports.map((report) => redeliverBrowserRunReport(delivery, report.id))
  );
  await watchOverdueReports(new Date());
}

/**
 * Check every open run once, in batches of the ones checked longest ago. A
 * run finished while dozens of others were still going reaches its person on
 * this poll, not once the older runs happen to settle.
 */
async function reconcileUnsettledBrowserRuns(
  delivery: BrowserRunDelivery,
  now: Date,
  batchesLeft = maximumPollBatches
): Promise<void> {
  if (batchesLeft <= 0) return;
  const runs = await takeUnsettledBrowserRuns({
    checkedBefore: now,
    limit: pollLimit,
    staleBefore: new Date(now.getTime() - settleAfterMs),
  });
  await Promise.all(runs.map((run) => reconcileBrowserRun(delivery, run, now)));
  if (runs.length < pollLimit) return;
  return reconcileUnsettledBrowserRuns(delivery, now, batchesLeft - 1);
}

async function reconcileBrowserRun(
  delivery: BrowserRunDelivery,
  run: Awaited<ReturnType<typeof takeUnsettledBrowserRuns>>[number],
  now: Date
) {
  const overdue = now.getTime() - run.createdAt.getTime() > abandonAfterMs;
  try {
    const status = await readBrowserUseRunStatus(run.id);
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      await settleBrowserRun(delivery, run.id);
      return;
    }
    if (overdue) await expireBrowserRun(delivery, run.id);
  } catch (error) {
    console.warn("[browser-use] run reconciliation failed", {
      cause: error,
      runId: run.id,
    });
    // A run Browser Use does not know will never settle, and one whose
    // status cannot be read still has to end for its person some time.
    if (error instanceof BrowserUseError && error.status === 404) {
      await safeExpire(
        delivery,
        run.id,
        "The cloud browser service no longer has this run, so its outcome is lost. Tell the user plainly and offer to start the errand again."
      );
    } else if (overdue) {
      await safeExpire(delivery, run.id);
    }
  }
}

async function safeExpire(
  delivery: BrowserRunDelivery,
  runId: string,
  outcome?: string
) {
  try {
    await expireBrowserRun(delivery, runId, outcome);
  } catch (error) {
    console.warn("[browser-use] the run could not be closed", {
      cause: error,
      runId,
    });
  }
}

const retryAgainAfterMs = 60_000;

/**
 * A step that throws here would otherwise leave the errand until the claim's
 * lease runs out. It is parked again for the next poll instead — marked as
 * out of attempts when it was, so that poll reports the wall rather than
 * starting another run.
 */
async function retryWalledBrowserRun(
  delivery: BrowserRunDelivery,
  run: Awaited<ReturnType<typeof claimDueBrowserRunRetries>>[number],
  now: Date
) {
  let exhausted = run.captchaAttempt >= maximumCaptchaAttempts;
  try {
    const retry = await startCaptchaRetry(run, now);
    exhausted = retry.status === "exhausted";
    if (exhausted) await reportWalledBrowserRun(delivery, run.id);
  } catch (error) {
    console.warn("[browser-use] anti-bot retry failed", {
      cause: error,
      runId: run.id,
    });
    try {
      await parkBrowserRunForRetry(run.id, {
        captchaAttempt: exhausted ? maximumCaptchaAttempts : run.captchaAttempt,
        retryAt: new Date(now.getTime() + retryAgainAfterMs),
      });
    } catch (parkError) {
      console.warn("[browser-use] the failed retry could not be parked", {
        cause: parkError,
        runId: run.id,
      });
    }
  }
}

/**
 * Start what the queue holds, longest-waiting first, until Browser Use says
 * it is busy again: the next errand would only get the same 429. A start that
 * fails otherwise is put back in line for the next minute rather than lost;
 * the queue window closes it eventually.
 */
async function drainBrowserQueue(
  delivery: BrowserRunDelivery,
  now: Date,
  startsLeft = maximumQueueStartsPerPoll
): Promise<void> {
  if (startsLeft <= 0) return;
  const row = await claimNextQueuedBrowserRun(now);
  if (!row) return;
  let result: Awaited<ReturnType<typeof startQueuedBrowserRun>>;
  try {
    result = await startQueuedBrowserRun(row, now);
  } catch (error) {
    console.warn("[browser-use] the queued errand could not start", {
      cause: error,
      runId: row.id,
    });
    try {
      await parkQueuedBrowserRun(row.id, queueRetryAt(now));
    } catch (parkError) {
      // The claim's lease puts it back in line anyway; the rest of the tick
      // (spend, redelivery, overdue reports) must not stop here.
      console.warn("[browser-use] the queued errand could not be parked", {
        cause: parkError,
        runId: row.id,
      });
    }
    return drainBrowserQueue(delivery, now, startsLeft - 1);
  }
  if (result.status === "expired" || result.status === "no_credits") {
    if (result.closed) {
      await reportClosedBrowserRun(delivery, result.closed, result.outcome);
    }
  }
  if (result.status === "busy" || result.status === "no_credits") return;
  return drainBrowserQueue(delivery, now, startsLeft - 1);
}

async function safeReconcileSpend(now: Date) {
  try {
    await reconcileSpendReservations(now);
  } catch (error) {
    console.warn("[browser-use] spend reservations could not be reconciled", {
      cause: error,
    });
  }
}

async function redeliverBrowserRunReport(
  delivery: BrowserRunDelivery,
  runId: string
) {
  try {
    await deliverBrowserRunReport(delivery, runId);
  } catch (error) {
    console.warn("[browser-use] report redelivery failed", {
      cause: error,
      runId,
    });
  }
}

/**
 * The measure the person feels: an errand is over, and they have not heard.
 * Every poll logs how many settled reports are older than two minutes and
 * still undelivered, and the owner hears about it — at most every few hours
 * while it lasts, and again at once after it cleared.
 */
async function watchOverdueReports(now: Date) {
  try {
    const overdue = await listOverdueBrowserRunReports(
      new Date(now.getTime() - reportOverdueAfterMs),
      now
    );
    if (overdue.length === 0) {
      await clearOwnerAlert(overdueAlertKey, now);
      return;
    }
    const oldest = overdue[0]?.completedAt ?? now;
    const count = overdue[0]?.total ?? overdue.length;
    console.warn("[browser-use] reports overdue", {
      count,
      oldestMinutes: Math.round((now.getTime() - oldest.getTime()) / 60_000),
      runs: overdue.map((row) => ({
        attempts: row.reportAttempts,
        channel: row.conversationChannel,
        runId: row.id,
      })),
    });
    await alertOwner(
      overdueAlertKey,
      `Итоги браузерных поручений не доходят до людей: ${String(count)} шт. дольше двух минут, самый старый — ${String(Math.round((now.getTime() - oldest.getTime()) / 60_000))} мин. Подробности в логах по «[browser-use] reports overdue».`,
      { now, repeatAfterMs: overdueAlertRepeatAfterMs }
    );
  } catch (error) {
    console.warn("[browser-use] overdue reports could not be checked", {
      cause: error,
    });
  }
}
