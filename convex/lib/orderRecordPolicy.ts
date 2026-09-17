/**
 * The one gate that decides whether a finished Browser Use Cloud run is an
 * order worth writing to `orders`.
 *
 * Both completion paths go through this function, so they cannot disagree
 * about what counts as a purchase:
 *  - the `browser_task` tool (agent/tools/browser_task.ts maybeRecordOrder) —
 *    a run that ends inside the model's own tool call;
 *  - the Convex follow-through (convex/browserFollow.ts pollRun /
 *    lateResultNotify) — a run that finishes in the background, which is now
 *    the common case: `deliverDoneNow` reports a clean terminal success
 *    straight from the poll and skips the model wakeup entirely, and the
 *    `done` wakeup prompt tells the model not to call `browser_task` anyway.
 *
 * Recording from both is harmless on purpose: `api.orders.record` upserts on
 * (tenantId, merchantOrderId), and the parse below is deterministic for a
 * given run, so a double write lands on the same row. A missing row is not
 * recoverable — «где мой заказ» finds nothing.
 */

import { parseCloudOutcome } from "./browserOutcomePolicy.ts";
import { isAttachCardErrand, taskLooksLikeBuy } from "./purchasePolicy.ts";
import { parseOrderFromResult, type ParsedOrder } from "./orderPolicy.ts";

export type RunForOrder = {
  /** Browser Use run status, as stored/polled ("completed", "failed", …). */
  status: string;
  /** The human errand text this run was started with. */
  task: string;
  result?: string | null;
  /** The run was started with a bound vault card (tenant.browserPaying). */
  paying: boolean;
  /** Payment hosts of the run — merchant detection prefers them over wording. */
  hosts?: readonly string[];
  now?: number;
};

export function orderRowFromRun(run: RunForOrder): ParsedOrder | null {
  if (run.status.trim().toLowerCase() !== "completed") return null;
  const task = run.task ?? "";
  const buy = taskLooksLikeBuy(task);
  if (!run.paying && !buy) return null;
  // «привяжи карту» pays nothing (bar the bank's ~1 ₽ hold) — a saved card is
  // not an order, and the hold must never be recorded as one.
  if (isAttachCardErrand(task) && !buy) return null;
  // A run that stopped on a blocker (3DS, a missing card, an OTP) is not a
  // placed order yet, whatever free-text guessing over its result might say.
  if (parseCloudOutcome(run.result).needs !== "none") return null;
  return parseOrderFromResult({
    task,
    result: run.result,
    hosts: run.hosts,
    pay: run.paying,
    ...(run.now === undefined ? {} : { now: run.now }),
  });
}
