import { defineSchedule } from "eve/schedules";
import {
  browserUseConfigured,
  readBrowserUseRunStatus,
} from "@agent/lib/browser-use/client";
import { startCaptchaRetry } from "@agent/lib/browser-use/captcha-retry";
import {
  deliverBrowserRunReport,
  expireBrowserRun,
  reportWalledBrowserRun,
  settleBrowserRun,
  type BrowserRunDelivery,
} from "@agent/lib/browser-use/completion";
import {
  claimDueBrowserRunRetries,
  listPendingBrowserRunReports,
  listUnsettledBrowserRuns,
} from "@db/services/browser-runs";

// A webhook that never arrives must not strand an errand, so every open run is
// reconciled from the cheap status endpoint until it reaches a terminal state.
// The schedule also holds a session handle, which is the only way to reach an
// eve chat, so every conversation gets its report from here without a webhook.
const settleAfterMs = 30_000;
const abandonAfterMs = 45 * 60_000;
const pollLimit = 25;

export default defineSchedule({
  cron: "* * * * *",
  run({ attachSession, to, waitUntil }) {
    if (!browserUseConfigured()) return;
    waitUntil(reconcileBrowserRuns({ attachSession, to }));
  },
});

async function reconcileBrowserRuns(delivery: BrowserRunDelivery) {
  const now = new Date();
  const runs = await listUnsettledBrowserRuns({
    limit: pollLimit,
    staleBefore: new Date(now.getTime() - settleAfterMs),
  });
  await Promise.all(runs.map((run) => reconcileBrowserRun(delivery, run, now)));
  // Errands parked on an anti-bot wall get their next attempt when it is due.
  const retries = await claimDueBrowserRunRetries(now, pollLimit);
  await Promise.all(
    retries.map((retry) => retryWalledBrowserRun(delivery, retry, now))
  );
  // A report still pending here is one whose delivery failed; it is retried
  // every poll until it lands or runs out of attempts.
  const reports = await listPendingBrowserRunReports(pollLimit);
  await Promise.all(
    reports.map((report) => redeliverBrowserRunReport(delivery, report.id))
  );
}

async function reconcileBrowserRun(
  delivery: BrowserRunDelivery,
  run: Awaited<ReturnType<typeof listUnsettledBrowserRuns>>[number],
  now: Date
) {
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
    if (now.getTime() - run.createdAt.getTime() > abandonAfterMs) {
      await expireBrowserRun(delivery, run.id);
    }
  } catch (error) {
    console.warn("[browser-use] run reconciliation failed", {
      cause: error,
      runId: run.id,
    });
  }
}

async function retryWalledBrowserRun(
  delivery: BrowserRunDelivery,
  run: Awaited<ReturnType<typeof claimDueBrowserRunRetries>>[number],
  now: Date
) {
  try {
    const retry = await startCaptchaRetry(run, now);
    if (retry.status === "exhausted") {
      await reportWalledBrowserRun(delivery, run.id);
    }
  } catch (error) {
    console.warn("[browser-use] anti-bot retry failed", {
      cause: error,
      runId: run.id,
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
