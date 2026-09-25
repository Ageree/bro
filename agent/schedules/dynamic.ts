import { parseInputResponses } from "eve/client";
import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";
import scheduledRunChannel from "@agent/channels/scheduled-run";
import {
  checkOpenRouterCredits,
  creditCheckDue,
} from "@agent/lib/model/credits";
import { proactiveReportTiming } from "@agent/lib/proactive/delivery";
import { dispatchScheduledReport } from "@agent/lib/schedules/report";
import {
  claimAnsweredScheduledAgentRuns,
  claimReadyScheduledAgentRuns,
  finishScheduledAgentRunInput,
  listRecoverableScheduledReports,
  materializeDueScheduledAgentRuns,
  recoverStuckScheduledAgentRuns,
  releaseScheduledAgentRun,
  restoreScheduledAgentRunInput,
  setScheduledRunSession,
} from "@db/services/scheduled-agent-jobs";
import { localRunLabel } from "@shared/schedules/timing";

const workerStartupLimitMs = 5 * 60_000;

/**
 * What a report needs to reach its conversation: `to` addresses a messaging
 * chat, and the session handle is the only way into a web chat. Web reports
 * used to go through the app's own `/internal/scheduled-run/report` route,
 * which Vercel never routes to eve, so none of them arrived.
 */
type ReportDelivery = Pick<ScheduleHandlerArgs, "attachSession" | "to">;

export default defineSchedule({
  cron: "* * * * *",
  run({ attachSession, to, waitUntil }) {
    waitUntil(dispatchDueWork({ attachSession, to }));
    // A run out of model credit fails every turn, so the owner hears about a
    // low balance from this tick before people hear silence.
    if (creditCheckDue(new Date())) waitUntil(checkOpenRouterCredits());
  },
});

async function dispatchDueWork(delivery: ReportDelivery) {
  const now = new Date();
  // Stuck workers first: a run sent back to the queue is claimed below, and
  // one that got stuck twice has its report picked up in the same tick.
  const recovered = await recoverStuckScheduledAgentRuns({ limit: 25, now });
  for (const run of recovered) {
    console.warn("[scheduled-run] watchdog", run);
  }
  const materializedRunIds = await materializeDueScheduledAgentRuns({
    limit: 25,
    now,
  });
  const runs = await claimReadyScheduledAgentRuns({
    leaseForMs: workerStartupLimitMs,
    limit: 25,
    now,
  });
  const reports = await listRecoverableScheduledReports(now, 25);
  const answered = await claimAnsweredScheduledAgentRuns({ limit: 25, now });
  if (
    materializedRunIds.length > 0 ||
    runs.length > 0 ||
    reports.length > 0 ||
    answered.length > 0
  ) {
    console.info("[scheduled-run] schedule tick found work", {
      answeredRunCount: answered.length,
      claimedRunCount: runs.length,
      materializedRunCount: materializedRunIds.length,
      recoverableReportCount: reports.length,
    });
  }
  await Promise.all([
    ...runs.map((claim) => executeScheduledRun(delivery, claim)),
    ...onePerProactiveJob(reports).map((report) =>
      dispatchRecoverableReport(delivery, report)
    ),
    ...answered.map((claim) => resumeAnsweredRun(delivery, claim)),
  ]);
}

/**
 * One report of Bro's own check per tick: the first takes the job's other
 * finished reports into its message (`absorbHeldProactiveReports`), and two
 * dispatched side by side would each claim its own and send two.
 */
function onePerProactiveJob(
  reports: Awaited<ReturnType<typeof listRecoverableScheduledReports>>
) {
  const proactiveJobs = new Set<string>();
  return reports.filter((report) => {
    if (report.jobKind !== "proactive") return true;
    if (proactiveJobs.has(report.jobId)) return false;
    proactiveJobs.add(report.jobId);
    return true;
  });
}

/**
 * Hands the person's answer to the worker session waiting on it.
 * `schedules-answer` only stores the answer: the app's own routes never reach
 * eve on Vercel, and only a schedule handler holds the worker's session.
 */
async function resumeAnsweredRun(
  delivery: ReportDelivery,
  claim: Awaited<ReturnType<typeof claimAnsweredScheduledAgentRuns>>[number]
) {
  const { inputResponses, leaseToken, workerSessionId } = claim.run;
  if (!inputResponses || !leaseToken || !workerSessionId) {
    throw new Error("An answered scheduled run requires its worker session.");
  }
  try {
    const result = await delivery
      .attachSession(workerSessionId)
      .respond(parseInputResponses(inputResponses), {
        auth: scheduledInputAuth(claim),
      });
    if (result.status === "accepted") {
      await finishScheduledAgentRunInput(claim.run.id, leaseToken);
      console.info("[scheduled-run] answer handed to worker", {
        runId: claim.run.id,
        sessionId: workerSessionId,
      });
      return;
    }
    // A worker still starting takes the answer on a later tick; one that
    // ended never will, so the run ends and a later tick reports it.
    await restoreScheduledAgentRunInput(
      claim.run.id,
      leaseToken,
      "The scheduled session is no longer active.",
      result.retryable === true ? { at: new Date(Date.now() + 60_000) } : null
    );
  } catch (error) {
    console.warn("[scheduled-run] answer hand-off failed", {
      cause: error,
      runId: claim.run.id,
    });
    await restoreScheduledAgentRunInput(
      claim.run.id,
      leaseToken,
      error instanceof Error ? error.message : String(error),
      { at: new Date(Date.now() + 5 * 60_000) }
    );
  }
}

function scheduledInputAuth(
  claim: Awaited<ReturnType<typeof claimAnsweredScheduledAgentRuns>>[number]
) {
  const attributes = new Map<string, string>([
    ["conversationChannel", claim.job.conversationChannel],
    ["conversationId", claim.job.conversationId],
    ["scheduleId", claim.job.id],
    ["scheduledRunId", claim.run.id],
    ["workspaceId", claim.job.workspaceId],
  ]);
  if (claim.job.kind === "proactive") {
    attributes.set("scheduledRunKind", "proactive");
  }
  return {
    attributes: Object.fromEntries(attributes),
    authenticator: "scheduled-input",
    issuer: "open-instinct",
    principalId: claim.job.createdByUserId,
    principalType: "user" as const,
  };
}

async function executeScheduledRun(
  delivery: ReportDelivery,
  claim: Awaited<ReturnType<typeof claimReadyScheduledAgentRuns>>[number]
) {
  const leaseToken = claim.run.leaseToken;
  if (!leaseToken) throw new Error("A scheduled run claim requires a lease.");
  console.info("[scheduled-run] dispatching worker", {
    attempt: claim.run.attempts,
    jobId: claim.job.id,
    runId: claim.run.id,
    scheduledFor: claim.run.scheduledFor.toISOString(),
  });
  try {
    const session = await delivery
      .to(scheduledRunChannel, {
        restart: claim.run.workerSessionId !== null,
        runId: claim.run.id,
      })
      .send(scheduledRunPrompt(claim), {
        auth: scheduledWorkerAuth(claim),
      });
    const persisted = await setScheduledRunSession(
      claim.run.id,
      leaseToken,
      session.id
    );
    if (!persisted) {
      throw new Error("The scheduled run lease expired during dispatch.");
    }
    console.info("[scheduled-run] worker session accepted", {
      jobId: claim.job.id,
      runId: claim.run.id,
      sessionId: session.id,
    });
  } catch (error) {
    console.warn("[scheduled-run] worker dispatch failed", {
      cause: error,
      jobId: claim.job.id,
      runId: claim.run.id,
    });
    const status = await releaseScheduledAgentRun(
      claim.run.id,
      leaseToken,
      error instanceof Error ? error.message : String(error)
    );
    if (status === "dead_letter") {
      await dispatchRecoverableReport(delivery, {
        carriesEvent: false,
        conversationChannel: claim.job.conversationChannel,
        jobId: claim.job.id,
        jobKind: claim.job.kind,
        runId: claim.run.id,
        scheduledFor: claim.run.scheduledFor,
        scope: {
          userId: claim.job.createdByUserId,
          workspaceId: claim.job.workspaceId,
        },
        timeSensitive: false,
      });
    }
  }
}

async function dispatchRecoverableReport(
  delivery: ReportDelivery,
  report: Awaited<ReturnType<typeof listRecoverableScheduledReports>>[number]
) {
  if (report.jobKind !== "proactive") {
    return dispatchScheduledReport(delivery, report.runId);
  }
  const timing = await proactiveReportTiming(report);
  if (timing === "held") return;
  // An urgent report at night goes alone; the held ones wait for the morning.
  return dispatchScheduledReport(delivery, report.runId, {
    absorbHeld: timing === "day",
  });
}

function scheduledRunPrompt(
  claim: Awaited<ReturnType<typeof claimReadyScheduledAgentRuns>>[number]
) {
  // «Сегодня» of a morning digest is the person's day, not the UTC one.
  const timing = claim.job.timing;
  const local =
    timing.kind === "calendar"
      ? ` (on the person's clock: ${localRunLabel(claim.run.scheduledFor, timing.timezone)})`
      : "";
  return [
    "Complete this user-owned scheduled task in an isolated background session.",
    `Scheduled for: ${claim.run.scheduledFor.toISOString()}${local}`,
    `Task: ${claim.job.prompt}`,
  ].join("\n\n");
}

function scheduledWorkerAuth(
  claim: Awaited<ReturnType<typeof claimReadyScheduledAgentRuns>>[number]
) {
  const leaseToken = claim.run.leaseToken;
  if (!leaseToken) throw new Error("A scheduled run claim requires a lease.");
  return {
    attributes: {
      conversationChannel: claim.job.conversationChannel,
      conversationId: claim.job.conversationId,
      scheduleId: claim.job.id,
      scheduledRunLeaseToken: leaseToken,
      scheduledRunId: claim.run.id,
      workspaceId: claim.job.workspaceId,
    },
    authenticator: "scheduled-worker",
    issuer: "open-instinct",
    principalId: claim.job.createdByUserId,
    principalType: "user" as const,
  };
}
