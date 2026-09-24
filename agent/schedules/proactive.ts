import { defineSchedule, type ScheduleToFn } from "eve/schedules";
import scheduledRunChannel from "@agent/channels/scheduled-run";
import { probeGoogleSignals } from "@agent/lib/proactive/probe";
import { quietHoursEnd } from "@agent/lib/proactive/quiet-hours";
import {
  mailSearchStart,
  proactiveRunPrompt,
  selectRunSignals,
} from "@agent/lib/proactive/signals";
import {
  advanceProactiveWatermark,
  claimDueProactiveWatches,
  deferProactiveWatch,
  filterUnseenProactiveSignals,
  listProactiveRunSignals,
  pruneProactiveSignals,
  queueProactiveRun,
} from "@db/services/proactive";
import {
  claimReadyScheduledAgentRuns,
  releaseScheduledAgentRun,
  setScheduledRunSession,
} from "@db/services/scheduled-agent-jobs";
import { resolveTimeZone } from "@shared/user-profile/schema";

// Each workspace is looked at every 15 minutes; the cron only spreads the
// checks. A missing Google grant is re-read a few times a day, not every tick.
const checkEveryMs = 15 * 60_000;
/**
 * At most this many model runs per workspace in any 24 hours; past it, new
 * signals wait. Twelve covers a heavy day of mail that matters.
 */
const maxRunsPerDay = 12;
const disconnectedRetryMs = 6 * 60 * 60_000;
const signalRetentionMs = 14 * 24 * 60 * 60_000;
const workerStartupLimitMs = 5 * 60_000;

export default defineSchedule({
  cron: "*/5 * * * *",
  run({ to, waitUntil }) {
    waitUntil(runProactiveChecks(to));
  },
});

async function runProactiveChecks(to: ScheduleToFn) {
  const now = new Date();
  await pruneProactiveSignals(new Date(now.getTime() - signalRetentionMs));
  const watches = await claimDueProactiveWatches({
    leaseForMs: checkEveryMs,
    limit: 25,
    now,
  });
  await Promise.all(watches.map((watch) => checkWorkspace(watch, now)));
  const runs = await claimReadyScheduledAgentRuns({
    kind: "proactive",
    leaseForMs: workerStartupLimitMs,
    limit: 25,
    now,
  });
  await Promise.all(runs.map((claim) => dispatchProactiveRun(to, claim)));
}

async function checkWorkspace(
  watch: Awaited<ReturnType<typeof claimDueProactiveWatches>>[number],
  now: Date
) {
  const timeZone = resolveTimeZone(watch.timezone);
  const quietUntil = quietHoursEnd(now, timeZone);
  if (quietUntil) {
    // The watermark stays put, so the morning check picks up the night's mail.
    await deferProactiveWatch(watch.workspaceId, quietUntil);
    return;
  }
  try {
    const probe = await probeGoogleSignals(
      { userId: watch.createdByUserId, workspaceId: watch.workspaceId },
      {
        mailAfter: mailSearchStart(watch.mailCheckedAt, now),
        now,
        timeZone,
      }
    );
    if (probe.state !== "connected") {
      await deferProactiveWatch(
        watch.workspaceId,
        new Date(now.getTime() + disconnectedRetryMs),
        "disconnected"
      );
      return;
    }
    const unseen = await filterUnseenProactiveSignals(
      watch.workspaceId,
      probe.signals
    );
    if (unseen.length === 0) {
      await advanceProactiveWatermark(watch.workspaceId, now);
      return;
    }
    // After a pause (a reconnect, the end of quiet hours, turning proactive
    // messages back on) the backlog becomes one catch-up run with the newest
    // items; the watermark moves past the rest instead of queuing batch after
    // batch of old mail.
    const queued = await queueProactiveRun({
      jobId: watch.jobId,
      mailCheckedAt: now,
      maxRunsPerDay,
      now,
      signals: selectRunSignals(unseen),
      workspaceId: watch.workspaceId,
    });
    console.info("[proactive] check found new signals", {
      signalCount: unseen.length,
      status: queued.status,
      workspaceId: watch.workspaceId,
    });
  } catch (error) {
    // The claim already moved the next check out; a Google hiccup waits for it.
    console.warn("[proactive] workspace check failed", {
      cause: error,
      workspaceId: watch.workspaceId,
    });
  }
}

async function dispatchProactiveRun(
  to: ScheduleToFn,
  claim: Awaited<ReturnType<typeof claimReadyScheduledAgentRuns>>[number]
) {
  const leaseToken = claim.run.leaseToken;
  if (!leaseToken) throw new Error("A scheduled run claim requires a lease.");
  try {
    const signals = await listProactiveRunSignals(claim.run.id);
    const session = await to(scheduledRunChannel, {
      restart: claim.run.workerSessionId !== null,
      runId: claim.run.id,
    }).send(
      proactiveRunPrompt({ scheduledFor: claim.run.scheduledFor, signals }),
      {
        auth: {
          attributes: {
            conversationChannel: claim.job.conversationChannel,
            conversationId: claim.job.conversationId,
            scheduleId: claim.job.id,
            scheduledRunKind: "proactive",
            scheduledRunLeaseToken: leaseToken,
            scheduledRunId: claim.run.id,
            workspaceId: claim.job.workspaceId,
          },
          authenticator: "scheduled-worker",
          issuer: "open-instinct",
          principalId: claim.job.createdByUserId,
          principalType: "user" as const,
        },
      }
    );
    const persisted = await setScheduledRunSession(
      claim.run.id,
      leaseToken,
      session.id
    );
    if (!persisted) {
      throw new Error("The scheduled run lease expired during dispatch.");
    }
  } catch (error) {
    console.warn("[proactive] worker dispatch failed", {
      cause: error,
      runId: claim.run.id,
    });
    await releaseScheduledAgentRun(
      claim.run.id,
      leaseToken,
      error instanceof Error ? error.message : String(error)
    );
  }
}
