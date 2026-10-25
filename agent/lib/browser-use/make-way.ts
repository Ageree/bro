import { makeWayPilot } from "@agent/lib/browser-vm/pilot";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  findBrowserRunMakingWay,
  makeWayForPersonErrand,
  listBrowserHoldingRuns,
  moveQueuedBrowserRunsBack,
} from "@db/services/browser-runs";
import { readBrowserVmRun } from "@db/services/browser-vms";
import { browserVmCallerTask } from "@agent/lib/browser-vm/runs";
import { browserUseBusy, cancelBrowserUseRun } from "./client";
import { onOwnBrowser } from "./own-browser";

/**
 * The longest a run that made way waits before it is tried again; the end
 * of the person's errand brings it forward (`hurryQueuedBrowserRuns`).
 */
const madeWayWaitMs = 5 * 60_000;

const pauseNote = "[Carried on after a pause]";
const queueReference = /^\(Queued errand .*; for bookkeeping only\.\)$/u;

/**
 * The instruction a run that made way starts with again: the one its errand
 * was given, without what its start and the queue added to it (they add
 * their own again) and with one pause note, replacing any earlier one.
 */
export function madeWayTask(task: string) {
  const base = browserVmCallerTask(task)
    .split("\n\n")
    .filter(
      (paragraph) =>
        !paragraph.startsWith(pauseNote) && !queueReference.test(paragraph)
    )
    .join("\n\n");
  return `${base}\n\n${pauseNote} Bro stopped this errand for a while to do another errand of the user's in this browser first. Carry on from where it stopped, in this tab if it is still open: do not check again what it already found.`;
}

/** Whether a queued errand is a run that made way for a person's errand. */
export function madeWay(row: { readonly pendingTask: string | null }) {
  return row.pendingTask?.includes(`\n\n${pauseNote} `) === true;
}

/**
 * The person gave a new errand while their browser was busy with one Bro
 * carries on by itself — as a rule a report turn's follow-up gathering more
 * of what they asked (owner, 25.10: a WB follow-up «добираю ещё два» held the
 * browser, and the next errand waited behind it). That run is closed as one
 * that made way, its worker run is stopped, and a queued copy of it starts
 * once the person's errand let the browser go: the person's errand comes
 * first, and the follow-up still reports to its own conversation.
 *
 * Only an errand that finds is stopped (`findBrowserRunMakingWay`): nothing
 * done in the person's name is ever interrupted. Answers the queued copy's
 * id, or undefined when nothing made way.
 */
export async function makeWayForPerson(
  scope: AccessScope,
  profileId: string,
  now = new Date()
) {
  if (!onOwnBrowser(profileId) || !(await makeWayPilot(scope))) {
    return undefined;
  }
  let queued: Awaited<ReturnType<typeof queueInstead>>;
  try {
    queued = await queueInstead(scope.workspaceId, profileId, now);
  } catch (error) {
    // Nothing was stopped: the person's errand waits its turn as before.
    console.warn("[browser-use] no run could make way", { cause: error });
    return undefined;
  }
  if (!queued) return undefined;
  try {
    await cancelBrowserUseRun(queued.from);
  } catch (error) {
    // The run goes on to its end unwatched, and the copy does its errand
    // again afterwards: the person's errand waits for it as before.
    console.warn("[browser-use] a run that made way could not be stopped", {
      cause: error,
      runId: queued.from,
    });
  }
  console.info("[browser-use] a run made way for the person's errand", {
    queuedRunId: queued.id,
    runId: queued.from,
  });
  return queued.id;
}

/** The run that makes way, closed and queued again: its id and the copy's. */
async function queueInstead(workspaceId: string, profileId: string, now: Date) {
  const holder = await findBrowserRunMakingWay(workspaceId, profileId, now);
  if (!holder) return undefined;
  const record = await readBrowserVmRun(holder.id);
  if (!record) return undefined;
  const queued = await makeWayForPersonErrand(holder.id, {
    pendingTask: madeWayTask(record.task),
    retryAt: new Date(now.getTime() + madeWayWaitMs),
  });
  return queued === undefined ? undefined : { from: holder.id, id: queued.id };
}

/**
 * How often, and how far apart, the person's errand tries its start again
 * once the run that made way was stopped: the worker answers a cancel when
 * the run has ended or after 20 s with its agent still on a step, so the
 * browser frees within a step or two of that.
 */
const freedTries = 4;
const freedPauseMs = 3_000;

/**
 * Start the person's errand in the browser a run just made way for. Busy
 * past the last try, the busy answer goes back to the caller, which queues
 * the errand as before (`waitBehindPerson` keeps it first in line).
 */
export async function startOnceFreed<T>(
  start: () => Promise<T>,
  onBusy: () => void,
  attempt = 1
): Promise<T> {
  try {
    return await start();
  } catch (error) {
    if (!browserUseBusy(error) || attempt >= freedTries) throw error;
    onBusy();
    await new Promise((resolve) => {
      setTimeout(resolve, freedPauseMs);
    });
    return startOnceFreed(start, onBusy, attempt + 1);
  }
}

/**
 * A person's errand of the workspace queued: the runs that made way wait
 * behind it, not only behind the errand they made way for (the line would
 * otherwise put them first, being older).
 */
export async function waitBehindPerson(scope: AccessScope, now = new Date()) {
  if (!(await makeWayPilot(scope))) return;
  await moveQueuedBrowserRunsBack(scope.workspaceId, `\n\n${pauseNote} `, now);
}

/**
 * Whether a run that made way waits on: a run the person started still
 * holds the browser, a page kept for their code or answer among them. The
 * copy taking the browser then would make the person's follow-up wait for
 * the very gathering that made way for them.
 */
export async function madeWayWaits(
  row: { readonly pendingTask: string | null; readonly workspaceId: string },
  now = new Date()
) {
  if (!madeWay(row)) return false;
  const holding = await listBrowserHoldingRuns(row.workspaceId, now);
  return holding.some((run) => run.startedByPerson !== false);
}
