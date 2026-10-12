import { readBugBotState, saveBugBotState } from "@db/services/bug-reports";
import { within } from "@agent/lib/browser-use/deadline";
import { callBotApi, updatesSchema } from "./api";
import { forwardPendingBugReports, handleBugBotUpdate } from "./process";
import { bugBotTarget } from "./target";

const tickBudgetMs = 55_000;
const pollSeconds = 25;
// A long poll may take its full length plus a margin before it is given up.
const pollDeadlineMs = (pollSeconds + 5) * 1000;
const shortestPollMs = 1_000;
const conflictPauseMs = 5 * 60_000;

/**
 * One schedule tick: long-poll `getUpdates` for up to `tickBudgetMs`, handle
 * each update once, move the stored offset past it. A 409 (another reader
 * holds this bot's updates: a webhook, or a second instance) pauses the bot
 * for five minutes instead of failing the tick. Every wait is bounded, since
 * Nitro hands a tick that finds the last one running the same promise.
 */
export async function runBugBotTick(now = () => new Date()) {
  const target = bugBotTarget();
  if (!target) return;
  const started = Date.now();
  const state = await readBugBotState(now());
  if (state.paused) return;
  await within(forwardPendingBugReports(target), 20_000);
  let nextOffset = state.nextOffset;
  while (
    Date.now() - started + pollDeadlineMs <=
    tickBudgetMs + pollSeconds * 200
  ) {
    const polledAt = Date.now();
    /* oxlint-disable eslint/no-await-in-loop -- Each poll continues from the offset the last one reached. */
    const polled = await within(
      callBotApi(
        target.botToken,
        "getUpdates",
        {
          allowed_updates: ["message"],
          offset: nextOffset,
          timeout: pollSeconds,
        },
        updatesSchema,
        pollDeadlineMs
      ),
      pollDeadlineMs + 1_000
    );
    if (polled.timedOut) return;
    const answer = polled.value;
    if (!answer.ok) {
      if (answer.code === 409) {
        await saveBugBotState({
          pausedUntil: new Date(now().getTime() + conflictPauseMs),
        });
        console.warn("[bug-bot] getUpdates answered 409, paused for 5 minutes");
      }
      return;
    }
    for (const update of answer.result) {
      try {
        await within(handleBugBotUpdate(target, update, now()), 20_000);
      } catch (error) {
        console.warn("[bug-bot] an update failed", {
          cause: error,
          updateId: update.update_id,
        });
      }
      nextOffset = Math.max(nextOffset, update.update_id + 1);
    }
    if (answer.result.length > 0) {
      await saveBugBotState({ nextOffset });
    } else if (Date.now() - polledAt < shortestPollMs) {
      // A long poll that comes back empty at once is not waiting: do not spin.
      return;
    }
    /* oxlint-enable eslint/no-await-in-loop */
  }
}
