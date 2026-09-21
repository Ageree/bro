import type { AttachSessionFn } from "eve/channels";
import type { ScheduleToFn } from "eve/schedules";
import {
  claimBrowserRunCompletion,
  readBrowserRun,
} from "@db/services/browser-runs";
import photon from "@agent/channels/photon";
import telegram from "@agent/channels/telegram";
import { telegramChatIdFromConversationId } from "@agent/lib/telegram-conversation";
import {
  cancelBrowserUseRun,
  readBrowserUseRun,
  type BrowserUseRunStatus,
} from "./client";
import { recordOrder } from "@db/services/orders";
import {
  browserOutcomeSummary,
  parseBrowserOrder,
  parseBrowserOutcome,
  type BrowserRunNeed,
} from "./outcome";

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
  await recordBrowserRunOrder(claimed, run.result);
  await deliverBrowserRunOutcome(delivery, claimed, outcome, parsed.needs);
}

/**
 * A purchase the run reported becomes a row before the person is told about
 * it, so «где мой заказ» in the next message already finds it. A failure here
 * never costs the report: the errand still happened.
 */
async function recordBrowserRunOrder(
  row: BrowserRunRow,
  result: string | null | undefined
) {
  const order = parseBrowserOrder(parseBrowserOutcome(result), {
    result,
    site: row.site,
    task: row.task,
  });
  if (!order) return;
  try {
    await recordOrder(
      { userId: row.createdByUserId, workspaceId: row.workspaceId },
      { ...order, browserRunId: row.id }
    );
  } catch (error) {
    console.warn("[browser-use] order could not be recorded", {
      cause: error,
      runId: row.id,
    });
  }
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
  await deliverBrowserRunOutcome(delivery, claimed, outcome, "none");
}

/**
 * What the coordinator is asked to do with the run it just got back. A run
 * parked on an anti-bot check has not finished the errand and leaves the
 * person nothing to act on, so that one case asks for a continuation — the
 * follow-up works the same browser, where the check is usually gone — instead
 * of a report. One continuation, though: a second check in a row is a wall the
 * run is not getting through, and then the person does need telling.
 */
function deliveryInstruction(needs: BrowserRunNeed) {
  const tail =
    "Answer a follow-up with browser_task continue on this run id instead of a new start: it picks the same browser up where this run left off and hands back the run id to use after that. Omit send_message.replyTo.";
  if (needs === "captcha") {
    return `This is a background result, not a user message. The run stopped on an anti-bot check, and that check is yours to get past rather than the user's: unless you already continued this errand once over the same check, call browser_task continue on this run id now, tell it to solve the check and finish the errand, and say nothing to the user about it. Only once a continuation has come back on the same check, tell the user plainly what is blocking and give them the live view. ${tail}`;
  }
  return `This is a background result, not a user message. Tell the user what happened in your own words. ${tail}`;
}

async function deliverBrowserRunOutcome(
  delivery: BrowserRunDelivery,
  row: BrowserRunRow,
  outcome: string,
  needs: BrowserRunNeed
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
      ? `Live view (share only for 3-D Secure, a push approval, a manual sign-in, or a check a continuation has already failed to get past): ${row.liveViewUrl}`
      : undefined,
    deliveryInstruction(needs),
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
    if (row.conversationChannel === "telegram") {
      const chatId = telegramChatIdFromConversationId(row.conversationId);
      if (!chatId) {
        throw new Error("A Telegram browser run requires a chat id.");
      }
      await delivery.to(telegram, { chatId }).send(prompt, options);
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
