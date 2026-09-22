import { defineSchedule, type ScheduleToFn } from "eve/schedules";
import {
  browserUseConfigured,
  readBrowserUseRunStatus,
} from "@agent/lib/browser-use/client";
import {
  cancelCorrelatedBrowserRuns,
  deliverSettledBrowserRun,
  expireBrowserRun,
  recoverBrowserRunLineage,
  settleBrowserRun,
} from "@agent/lib/browser-use/completion";
import {
  listBrowserRunsForReconciliation,
  markStaleBrowserRunDeliveryAmbiguous,
  readBrowserRun,
} from "@db/services/browser-runs";

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
  const runs = await listBrowserRunsForReconciliation({
    limit: pollLimit,
    staleBefore: new Date(now.getTime() - settleAfterMs),
  });
  await Promise.all(runs.map((run) => reconcileBrowserRun(to, run, now)));
}

async function reconcileBrowserRun(
  to: ScheduleToFn,
  run: Awaited<ReturnType<typeof listBrowserRunsForReconciliation>>[number],
  now: Date
) {
  try {
    if (run.completedAt) {
      await cancelCorrelatedBrowserRuns(run);
      if (run.deliveryState === "pending") {
        await deliverSettledBrowserRun({ to }, run.id);
      } else if (run.deliveryState === "claimed") {
        const ambiguous = await markStaleBrowserRunDeliveryAmbiguous({
          claimedBefore: new Date(now.getTime() - settleAfterMs),
          rootRunId: run.id,
        });
        if (ambiguous) {
          console.warn(
            "[browser-use] stale claimed delivery marked ambiguous",
            {
              runId: run.id,
            }
          );
        }
      }
      return;
    }
    if (
      run.lineageState === "claimed" ||
      run.lineageState === "creating" ||
      run.lineageState === "recovering"
    ) {
      await recoverBrowserRunLineage(run);
      return;
    }
    const activeRunId = run.activeRunId ?? run.id;
    const active =
      activeRunId === run.id ? run : await readBrowserRun(activeRunId);
    if (!active) return;
    const status = await readBrowserUseRunStatus(active.id);
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      await settleBrowserRun({ to }, active.id);
      return;
    }
    if (
      run.repairState === "running" &&
      run.repairDeadline &&
      now >= run.repairDeadline
    ) {
      await expireBrowserRun({ to }, active.id);
      return;
    }
    if (now.getTime() - active.updatedAt.getTime() > abandonAfterMs) {
      await expireBrowserRun({ to }, active.id);
    }
  } catch (error) {
    console.warn("[browser-use] run reconciliation failed", {
      errorName: error instanceof Error ? error.name : "unknown",
      runId: run.id,
    });
  }
}
