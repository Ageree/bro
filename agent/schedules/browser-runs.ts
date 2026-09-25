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
import { within } from "@agent/lib/browser-use/deadline";
import {
  deliverBrowserRunReport,
  expireBrowserRun,
  reportClosedBrowserRun,
  reportWalledBrowserRun,
  settleBrowserRun,
  type BrowserRunDelivery,
} from "@agent/lib/browser-use/completion";
import { stopClaimedBrowser } from "@agent/lib/browser-use/release";
import { alertOwner, clearOwnerAlert } from "@agent/lib/owner-alert";
import {
  claimDueBrowserRunRetries,
  claimNextQueuedBrowserRun,
  hasLiveBrowserRuns,
  listOverdueBrowserRunReports,
  listPendingBrowserRunReports,
  parkBrowserRunForRetry,
  otherRunHoldsBrowser,
  parkQueuedBrowserRun,
  takeIdleBrowserRuns,
  takeUnsettledBrowserRuns,
  unclaimBrowserRunBrowser,
} from "@db/services/browser-runs";

// Browser Use sends no webhook for a v4 run ("for V4 run monitoring, poll"),
// so every open run is reconciled from the cheap status endpoint until it
// reaches a terminal state. The schedule also holds a session handle, which is
// the only way to reach an eve chat, so every conversation gets its report
// from here.
const settleAfterMs = 5_000;
const abandonAfterMs = 45 * 60_000;
const pollLimit = 25;
/**
 * Batches one poll may take. Every open run is checked each minute up to
 * this many; past it, the runs checked longest ago go first next minute.
 */
const maximumPollBatches = 8;
/** Browsers free up one run at a time; a minute seldom frees more. */
const maximumQueueStartsPerPoll = 5;
/** Pages kept for the person are few; each stop is two reads and a stop. */
const idleClosesPerPoll = 10;
/**
 * While another browser of the workspace is up, a kept page waits for it up
 * to here: short of the cloud's own cleanup at about twenty minutes, and
 * long enough that the other one usually stops first.
 */
const idleCloseLatestMs = 18 * 60_000;
/** A settled run's report should be in the chat within the minute. */
const reportOverdueAfterMs = 2 * 60_000;
const overdueAlertKey = "browser-use-undelivered-reports";
const overdueAlertRepeatAfterMs = 6 * 60 * 60_000;
/**
 * Cron ticks once a minute, and a report that waits for the next tick waited
 * up to a minute after the run was done. While runs are open, each tick keeps
 * looking at them this often, so a finished run reaches its person within
 * seconds.
 */
const livePollIntervalMs = 4_000;
/**
 * How long a tick keeps watching. It has to end before the next tick: Nitro
 * answers a tick that finds this task still running with the running
 * promise, so a watch that overran would cost the next minute its own.
 */
const liveWatchMs = 45_000;

/**
 * How long a tick waits on one open run, and on one stage, before it moves
 * on. Settling a run reads Browser Use, captures its pictures, stops its
 * browser and hands the report over; the work goes on past this, but the
 * other runs, the redelivery and the overdue watch no longer wait for it.
 * Nothing bounded a tick before: one call that never answered held it, and
 * Nitro handed every later tick of the instance the same stuck promise.
 */
const runReconcileWaitMs = 30_000;
const stageWaitMs = 40_000;

export default defineSchedule({
  cron: "* * * * *",
  run({ attachSession, to, waitUntil }) {
    if (!browserUseConfigured()) return;
    waitUntil(pollBrowserRuns({ attachSession, to }));
  },
});

/**
 * eve settles a schedule's background work without looking at the result, so
 * a tick that failed would otherwise leave no trace at all.
 */
async function pollBrowserRuns(delivery: BrowserRunDelivery) {
  try {
    await reconcileBrowserRuns(delivery);
  } catch (error) {
    console.error("[browser-use] poll failed", { cause: error });
  }
}

async function reconcileBrowserRuns(delivery: BrowserRunDelivery) {
  const now = new Date();
  const watchUntil = now.getTime() + liveWatchMs;
  // Each stage stands on its own: one that throws must not cost the rest of
  // the tick — the redelivery, the overdue watch and the live watch least of
  // all, which are what gets a report out when something upstream went wrong.
  await pollStage("settle", () => reconcileUnsettledBrowserRuns(delivery, now));
  // Errands parked on an anti-bot wall get their next attempt when it is due.
  await pollStage("retry", async () => {
    const retries = await claimDueBrowserRunRetries(now, pollLimit);
    await Promise.all(
      retries.map((retry) => retryWalledBrowserRun(delivery, retry, now))
    );
  });
  // A page kept for the person that has sat idle is stopped by Bro before
  // the cloud ends it and loses its sign-ins.
  await pollStage("idle", () => closeIdleBrowsers(now));
  // Settling and the idle stops freed browsers and sign-ins; errands waiting
  // for either start now.
  await pollStage("queue", () => drainBrowserQueue(delivery, now));
  await pollStage("spend", () => reconcileSpendReservations(now));
  // A report still pending here is one whose delivery failed; it is retried
  // every poll until it lands or runs out of attempts.
  await pollStage("redeliver", () => redeliverPendingReports(delivery));
  await pollStage("overdue", () => watchOverdueReports(new Date()));
  await watchLiveBrowserRuns(delivery, watchUntil);
}

async function pollStage(stage: string, work: () => Promise<void>) {
  try {
    const done = await within(work(), stageWaitMs);
    if (done.timedOut) {
      console.warn("[browser-use] poll stage is still going", {
        stage,
        waitedMs: stageWaitMs,
      });
    }
  } catch (error) {
    console.warn("[browser-use] poll stage failed", { cause: error, stage });
  }
}

/**
 * Stop the browsers of settled runs whose page was kept for the person — a
 * code, an approval, 3-D Secure, a manual sign-in, an option staged for
 * their card — and has sat idle a quarter of an hour. The cloud's own idle
 * cleanup comes a few minutes later and loses what changed in the browser:
 * a push the person approved without saying so, a sign-in finished before
 * a card nobody answered. Taking a run claims its page, so a follow-up that
 * arrives meanwhile opens a fresh browser instead of one being stopped.
 *
 * Whether Browser Use merges the cookies of two browsers on one profile or
 * keeps those of the one that stops last is not known. So while another
 * browser of the workspace is up, the kept page waits for it a few minutes
 * (`idleCloseLatestMs`): stopping last is what keeps its sign-in if the
 * last one wins. The stop at settle does not wait (dev-notes).
 */
async function closeIdleBrowsers(now: Date) {
  const idle = await takeIdleBrowserRuns(now, idleClosesPerPoll);
  const closed = await Promise.all(
    idle.map(async (run) => {
      if (run.sessionId === null) return false;
      const settledAgo = now.getTime() - (run.completedAt ?? now).getTime();
      if (
        settledAgo < idleCloseLatestMs &&
        (await otherRunHoldsBrowser(run.workspaceId, run.id, now))
      ) {
        await unclaimBrowserRunBrowser(run.id, now);
        return false;
      }
      return stopClaimedBrowser(run.id, run.sessionId, now);
    })
  );
  if (idle.length > 0) {
    console.info("[browser-use] idle browsers stopped", {
      closed: closed.filter(Boolean).length,
      looked: idle.length,
    });
  }
}

async function redeliverPendingReports(delivery: BrowserRunDelivery) {
  const reports = await listPendingBrowserRunReports(pollLimit);
  await Promise.all(
    reports.map((report) => redeliverBrowserRunReport(delivery, report.id))
  );
}

/**
 * Between ticks, look at the open runs every few seconds and settle the ones
 * that finished, and send again a report whose turn failed. Nothing open,
 * nothing to watch: the tick ends at once.
 */
async function watchLiveBrowserRuns(
  delivery: BrowserRunDelivery,
  until: number
): Promise<void> {
  if (Date.now() + livePollIntervalMs > until) return;
  if (!(await safeHasLiveBrowserRuns())) return;
  await new Promise((resolve) => setTimeout(resolve, livePollIntervalMs));
  await pollStage("watch", async () => {
    await reconcileUnsettledBrowserRuns(delivery, new Date());
    await redeliverPendingReports(delivery);
  });
  return watchLiveBrowserRuns(delivery, until);
}

async function safeHasLiveBrowserRuns() {
  try {
    const live = await within(hasLiveBrowserRuns(), stageWaitMs);
    return !live.timedOut && live.value;
  } catch (error) {
    console.warn("[browser-use] open runs could not be read", {
      cause: error,
    });
    return false;
  }
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
  await Promise.all(
    runs.map((run) => reconcileBrowserRunWithin(delivery, run, now))
  );
  if (runs.length < pollLimit) return;
  return reconcileUnsettledBrowserRuns(delivery, now, batchesLeft - 1);
}

async function reconcileBrowserRunWithin(
  delivery: BrowserRunDelivery,
  run: Awaited<ReturnType<typeof takeUnsettledBrowserRuns>>[number],
  now: Date
) {
  const reconciled = await within(
    reconcileBrowserRun(delivery, run, now),
    runReconcileWaitMs
  );
  if (reconciled.timedOut) {
    console.warn("[browser-use] run reconciliation is still going", {
      runId: run.id,
      waitedMs: runReconcileWaitMs,
    });
  }
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
      const settled = await settleBrowserRun(delivery, run.id, status);
      if (settled.kind !== "open") return;
      // The status says the run ended, its summary does not, and it has no
      // result yet: the next poll looks again. Past the errand's time it is
      // closed all the same, so the person hears something.
      console.warn("[browser-use] the run ended but its summary has not", {
        overdue,
        runId: run.id,
        status,
        summaryStatus: settled.summaryStatus,
      });
      if (overdue) {
        await expireBrowserRun(
          delivery,
          run.id,
          "The cloud browser service reports this run as finished but never handed back its result, so its outcome is lost. Tell the user plainly and offer to run the errand again."
        );
      }
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
  // An errand still waiting on its workspace's other browser started
  // nothing and took no slot; it is parked past this tick, so the next
  // claim is another errand.
  if (result.status === "waiting") {
    return drainBrowserQueue(delivery, now, startsLeft);
  }
  return drainBrowserQueue(delivery, now, startsLeft - 1);
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
