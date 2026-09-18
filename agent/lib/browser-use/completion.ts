import type { AttachSessionFn } from "eve/channels";
import type { ScheduleToFn } from "eve/schedules";
import {
  claimBrowserRunCompletion,
  readBrowserRun,
} from "@db/services/browser-runs";
import photon from "@agent/channels/photon";
import {
  cancelBrowserUseRun,
  readBrowserUseRun,
  type BrowserUseRunStatus,
} from "./client";
import { browserOutcomeSummary, parseBrowserOutcome } from "./outcome";

/**
 * Both completion paths — the Browser Use webhook and the reconciling poller —
 * land here, and the `completed_at` claim inside decides which one of them
 * actually reports the errand back to the user.
 */
export interface BrowserRunDelivery {
  readonly attachSession?: AttachSessionFn;
  readonly to: ScheduleToFn;
}

type BrowserRunRow = NonNullable<Awaited<ReturnType<typeof readBrowserRun>>>;

const terminalRunStatuses = new Set<BrowserUseRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

function settledStatus(status: BrowserUseRunStatus) {
  if (status === "completed") return "done" as const;
  if (status === "cancelled") return "stopped" as const;
  return "failed" as const;
}

export async function settleBrowserRun(
  delivery: BrowserRunDelivery,
  runId: string
) {
  const row = await readBrowserRun(runId);
  if (!row || row.completedAt) return;

  const run = await readBrowserUseRun(runId);
  if (!terminalRunStatuses.has(run.status)) return;

  const parsed = parseBrowserOutcome(run.result);
  const outcome = browserOutcomeSummary(
    parsed,
    run.error ?? `The run ended as ${run.status}.`
  );
  const claimed = await claimBrowserRunCompletion(runId, {
    outcome,
    status: settledStatus(run.status),
  });
  if (!claimed) return;
  await deliverBrowserRunOutcome(delivery, claimed, outcome);
}

/**
 * A run that never reached a terminal status is not going to. Cancelling it
 * first stops the meter before the row is closed and the user is told.
 */
export async function expireBrowserRun(
  delivery: BrowserRunDelivery,
  runId: string
) {
  try {
    await cancelBrowserUseRun(runId);
  } catch (error) {
    console.warn("[browser-use] expiring run could not be cancelled", {
      cause: error,
      runId,
    });
  }
  const outcome = "The browser run ran out of time and was cancelled.";
  const claimed = await claimBrowserRunCompletion(runId, {
    outcome,
    status: "failed",
  });
  if (!claimed) return;
  await deliverBrowserRunOutcome(delivery, claimed, outcome);
}

async function deliverBrowserRunOutcome(
  delivery: BrowserRunDelivery,
  row: BrowserRunRow,
  outcome: string
) {
  const options = {
    auth: {
      attributes: {
        browserRunId: row.id,
        conversationChannel: row.conversationChannel,
        conversationId: row.conversationId,
        workspaceId: row.workspaceId,
      },
      authenticator: "browser-result",
      issuer: "open-instinct",
      principalId: row.createdByUserId,
      principalType: "user" as const,
    },
    turnPolicy: "queue" as const,
  };
  const prompt = [
    `Browser run ${row.id} finished: ${outcome}`,
    `Errand: ${row.task}`,
    row.liveViewUrl
      ? `Live view (share only for a CAPTCHA, 3-D Secure, push approval, or manual sign-in): ${row.liveViewUrl}`
      : undefined,
    "This is a background result, not a user message. Tell the user what happened in your own words. Answer a follow-up with browser_task continue on this run id instead of starting a new run, and omit send_message.replyTo.",
  ]
    .filter((line) => line !== undefined)
    .join("\n\n");

  try {
    if (row.conversationChannel === "photon") {
      await delivery
        .to(photon, { adapterName: "imessage", threadId: row.conversationId })
        .send(prompt, options);
      return;
    }
    if (!delivery.attachSession) {
      throw new Error("Eve conversations need an active session handle.");
    }
    await delivery.attachSession(row.conversationId).send(prompt, options);
  } catch (error) {
    console.warn("[browser-use] outcome delivery failed", {
      cause: error,
      channel: row.conversationChannel,
      runId: row.id,
    });
  }
}
