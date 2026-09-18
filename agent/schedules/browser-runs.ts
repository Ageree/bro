import { defineSchedule, type ScheduleToFn } from "eve/schedules";
import {
  browserUseConfigured,
  readBrowserUseRunStatus,
} from "@agent/lib/browser-use/client";
import {
  expireBrowserRun,
  settleBrowserRun,
} from "@agent/lib/browser-use/completion";
import { listUnsettledBrowserRuns } from "@db/services/browser-runs";

// A webhook that never arrives must not strand an errand, so every open run is
// reconciled from the cheap status endpoint until it reaches a terminal state.
const settleAfterMs = 30_000;
const abandonAfterMs = 45 * 60_000;
const pollLimit = 25;

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    if (!browserUseConfigured()) return;
    waitUntil(reconcileBrowserRuns(to));
  },
});

async function reconcileBrowserRuns(to: ScheduleToFn) {
  const now = new Date();
  const runs = await listUnsettledBrowserRuns({
    limit: pollLimit,
    staleBefore: new Date(now.getTime() - settleAfterMs),
  });
  await Promise.all(runs.map((run) => reconcileBrowserRun(to, run, now)));
}

async function reconcileBrowserRun(
  to: ScheduleToFn,
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
      await settleBrowserRun({ to }, run.id);
      return;
    }
    if (now.getTime() - run.createdAt.getTime() > abandonAfterMs) {
      await expireBrowserRun({ to }, run.id);
    }
  } catch (error) {
    console.warn("[browser-use] run reconciliation failed", {
      cause: error,
      runId: run.id,
    });
  }
}
