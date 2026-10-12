import {
  acquireBugBotLease,
  readBugBotState,
  recordBugBotUpdateFailure,
  releaseBugBotLease,
  saveBugBotState,
} from "@db/services/bug-reports";
import { alertOwner } from "@agent/lib/owner-alert";
import { within } from "@agent/lib/browser-use/deadline";
import { callBotApi, updatesSchema, type BugBotUpdate } from "./api";
import { forwardPendingBugReports, handleBugBotUpdate } from "./process";
import { bugBotTarget } from "./target";

const tickBudgetMs = 55_000;
const pollSeconds = 25;
// A long poll may take its full length plus a margin before it is given up.
const pollDeadlineMs = (pollSeconds + 5) * 1000;
const shortestPollMs = 1_000;
// Longer than a tick can run: 55 s of polling plus the update in hand.
const leaseMs = 2 * 60_000;
const updateDeadlineMs = 20_000;
const failuresBeforeSkip = 3;
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
  warnOnChannelChat(target.ownerChatId);
  const state = await readBugBotState(now());
  if (state.paused) return;
  // A tick that runs past its minute must not meet the next one on
  // getUpdates: that one would get a 409 and pause the bot.
  if (!(await acquireBugBotLease(now(), leaseMs))) return;
  try {
    await pollAndHandle(target, state.nextOffset, now);
  } finally {
    try {
      await releaseBugBotLease();
    } catch (error) {
      console.warn("[bug-bot] the lease was not released", { cause: error });
    }
  }
}

let warnedOnChannel = false;

/** Replies can only come from a numeric chat id, not an @channel. */
function warnOnChannelChat(ownerChatId: string) {
  if (warnedOnChannel || /^-?\d+$/u.test(ownerChatId)) return;
  warnedOnChannel = true;
  console.warn(
    "[bug-bot] OPS_ALERT_CHAT_ID is not a numeric chat id: the owner's replies will not reach people"
  );
}

async function pollAndHandle(
  target: NonNullable<ReturnType<typeof bugBotTarget>>,
  firstOffset: number,
  now: () => Date
) {
  const started = Date.now();
  await within(forwardPendingBugReports(target), updateDeadlineMs);
  let nextOffset = firstOffset;
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
    let stopped = false;
    for (const update of answer.result) {
      // The tick's minute is over: what is left is read again next time.
      if (Date.now() - started > tickBudgetMs) {
        stopped = true;
        break;
      }
      if (await handled(target, update, now)) {
        nextOffset = Math.max(nextOffset, update.update_id + 1);
      } else {
        stopped = true;
        break;
      }
    }
    if (nextOffset !== firstOffset) {
      await saveBugBotState({ nextOffset });
      firstOffset = nextOffset;
    }
    if (stopped) return;
    if (answer.result.length === 0 && Date.now() - polledAt < shortestPollMs) {
      // A long poll that comes back empty at once is not waiting: do not spin.
      return;
    }
    /* oxlint-enable eslint/no-await-in-loop */
  }
}

/**
 * Whether the offset may move past this update: it was handled, or it has
 * failed too many times and is skipped, with the owner told, so that one
 * poison update cannot block the queue. A failure or a timeout is not
 * "handled": the update is read again on the next tick.
 */
async function handled(
  target: NonNullable<ReturnType<typeof bugBotTarget>>,
  update: BugBotUpdate,
  now: () => Date
) {
  try {
    const result = await within(
      handleBugBotUpdate(target, update, now()),
      updateDeadlineMs
    );
    if (!result.timedOut) return true;
  } catch (error) {
    console.warn("[bug-bot] an update failed", {
      cause: error,
      updateId: update.update_id,
    });
  }
  const failures = await recordBugBotUpdateFailure(update.update_id);
  if (failures < failuresBeforeSkip) return false;
  console.warn("[bug-bot] an update is skipped after repeated failures", {
    updateId: update.update_id,
  });
  await alertOwner(
    `bug-bot-update-${String(update.update_id)}`,
    `Бот баг-репортов пропустил сообщение (update ${String(update.update_id)}): оно не обработалось ${String(failures)} раза подряд.`,
    { repeatAfterMs: 24 * 60 * 60_000 }
  ).catch(() => false);
  return true;
}
