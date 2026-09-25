import { defineHook } from "eve/hooks";
import { scheduledRunIdentity } from "@agent/lib/schedules/identity";
import { workerOutcome } from "@agent/lib/schedules/outcome";
import {
  completeScheduledAgentRun,
  deferScheduledAgentRunCompletion,
  markScheduledAgentRunStarted,
  parkScheduledAgentRunOnAuthorization,
  releaseScheduledAgentRun,
  waitForScheduledAgentRunInput,
} from "@db/services/scheduled-agent-jobs";

const workerRuntimeLimitMs = 6 * 60 * 60_000;
/**
 * Bro's own check reads a dozen messages and a calendar: minutes, not hours.
 * While its run is open no later check starts, so one that hangs is handed to
 * the watchdog after this long instead of silencing the person's mail for
 * six hours.
 */
const proactiveRuntimeLimitMs = 30 * 60_000;

export default defineHook({
  events: {
    async "turn.started"(event, ctx) {
      const identity = scheduledRunIdentity(ctx.session.auth);
      if (!identity) return;
      const started = await markScheduledAgentRunStarted(
        identity.runId,
        identity.leaseToken,
        ctx.session.id,
        identity.proactive ? proactiveRuntimeLimitMs : workerRuntimeLimitMs,
        new Date(event.meta.at)
      );
      if (!started) {
        console.warn("[scheduled-run] worker started with a stale lease", {
          runId: identity.runId,
          sessionId: ctx.session.id,
        });
        return;
      }
      console.info("[scheduled-run] worker turn started", {
        runId: identity.runId,
        sessionId: ctx.session.id,
      });
    },
    // A sign-in card in a background session reaches nobody, so the worker
    // would wait for it until its lease ran out. The watchdog takes the run
    // on the next tick instead: once more from the start, then a report.
    async "authorization.required"(event, ctx) {
      const identity = scheduledRunIdentity(ctx.session.auth);
      if (!identity) return;
      const parked = await parkScheduledAgentRunOnAuthorization(
        identity.runId,
        identity.leaseToken,
        event.data.name,
        new Date(event.meta.at)
      );
      console.warn("[scheduled-run] worker parked on authorization", {
        connection: event.data.name,
        parked,
        runId: identity.runId,
        sessionId: ctx.session.id,
      });
    },
    async "input.requested"(event, ctx) {
      const identity = scheduledRunIdentity(ctx.session.auth);
      if (!identity) return;
      const waiting = await waitForScheduledAgentRunInput(
        identity.runId,
        identity.leaseToken,
        event.data.requests,
        new Date(event.meta.at)
      );
      if (waiting?.reportStatus !== "pending") {
        console.warn("[scheduled-run] input request missed its active lease", {
          runId: identity.runId,
          sessionId: ctx.session.id,
        });
        return;
      }
      console.info("[scheduled-run] worker waiting for input", {
        requestCount: event.data.requests.length,
        runId: waiting.id,
        sessionId: ctx.session.id,
      });
      console.info("[scheduled-run] input report queued", {
        runId: waiting.id,
        sessionId: ctx.session.id,
      });
    },
    async "subagent.completed"(event, ctx) {
      if (!event.data.backgroundTask) return;
      const identity = scheduledRunIdentity(ctx.session.auth);
      if (!identity) return;
      const deferred = await deferScheduledAgentRunCompletion(
        identity.runId,
        identity.leaseToken,
        ctx.session.turn.id,
        new Date(event.meta.at)
      );
      console.info("[scheduled-run] worker delegated background work", {
        deferred,
        runId: identity.runId,
        sessionId: ctx.session.id,
        taskId: event.data.backgroundTask.taskId,
        turnId: ctx.session.turn.id,
      });
    },
    async "message.completed"(event, ctx) {
      const identity = scheduledRunIdentity(ctx.session.auth);
      if (!identity) return;
      if (event.data.finishReason === "tool-calls") return;
      if (event.data.finishReason !== "stop") {
        const status = await releaseScheduledAgentRun(
          identity.runId,
          identity.leaseToken,
          `Scheduled worker stopped with finish reason: ${event.data.finishReason}.`,
          new Date(event.meta.at)
        );
        console.warn("[scheduled-run] worker stopped without a final result", {
          finishReason: event.data.finishReason,
          nextStatus: status,
          runId: identity.runId,
          sessionId: ctx.session.id,
        });
        logDeadLetterReportQueued(status, identity.runId, ctx.session.id);
        return;
      }
      const outcome = workerOutcome(event.data.message);
      const completed = await completeScheduledAgentRun(
        identity.runId,
        identity.leaseToken,
        event.data.turnId,
        outcome,
        new Date(event.meta.at)
      );
      if (completed?.status === "deferred") {
        console.info(
          "[scheduled-run] worker completion deferred for background work",
          {
            runId: identity.runId,
            sessionId: ctx.session.id,
            turnId: event.data.turnId,
          }
        );
        return;
      }
      if (!completed) {
        console.warn("[scheduled-run] worker completion missed its lease", {
          runId: identity.runId,
          sessionId: ctx.session.id,
        });
        return;
      }
      console.info("[scheduled-run] worker completed", {
        outcomeKind: outcome.kind,
        reportStatus: completed.run.reportStatus,
        runId: completed.run.id,
        sessionId: ctx.session.id,
      });
      if (completed.run.reportStatus === "pending") {
        console.info("[scheduled-run] completion report queued", {
          runId: completed.run.id,
          sessionId: ctx.session.id,
        });
      }
    },
    async "turn.failed"(event, ctx) {
      const identity = scheduledRunIdentity(ctx.session.auth);
      if (!identity) return;
      const status = await releaseScheduledAgentRun(
        identity.runId,
        identity.leaseToken,
        event.data.message,
        new Date(event.meta.at)
      );
      console.warn("[scheduled-run] worker turn failed", {
        nextStatus: status,
        runId: identity.runId,
        sessionId: ctx.session.id,
      });
      logDeadLetterReportQueued(status, identity.runId, ctx.session.id);
    },
    async "turn.cancelled"(event, ctx) {
      const identity = scheduledRunIdentity(ctx.session.auth);
      if (!identity) return;
      const status = await releaseScheduledAgentRun(
        identity.runId,
        identity.leaseToken,
        "Scheduled worker was cancelled.",
        new Date(event.meta.at)
      );
      console.warn("[scheduled-run] worker turn cancelled", {
        nextStatus: status,
        runId: identity.runId,
        sessionId: ctx.session.id,
      });
      logDeadLetterReportQueued(status, identity.runId, ctx.session.id);
    },
    async "session.failed"(event, ctx) {
      const identity = scheduledRunIdentity(ctx.session.auth);
      if (!identity) return;
      const status = await releaseScheduledAgentRun(
        identity.runId,
        identity.leaseToken,
        event.data.message,
        new Date(event.meta.at)
      );
      console.warn("[scheduled-run] worker session failed", {
        nextStatus: status,
        runId: identity.runId,
        sessionId: ctx.session.id,
      });
      logDeadLetterReportQueued(status, identity.runId, ctx.session.id);
    },
  },
});

function logDeadLetterReportQueued(
  status: Awaited<ReturnType<typeof releaseScheduledAgentRun>>,
  runId: string,
  sessionId: string
) {
  if (status !== "dead_letter") return;
  console.info("[scheduled-run] dead-letter report queued", {
    runId,
    sessionId,
  });
}
