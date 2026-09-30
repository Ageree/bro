import type { browserVms } from "@db/schema/browser-vms";
import { readBrowserRun } from "@db/services/browser-runs";
import {
  clearBrowserVmStopNotBefore,
  ensureBrowserVmRecord,
  extendBrowserVmStopNotBefore,
} from "@db/services/browser-vms";
import { env } from "@shared/environment";
import { browserVmWorkspace, isBrowserVmId } from "./ids";

/**
 * How long a workspace's browser VM stays up after its errand, by who woke
 * it (`docs/agent-costs.md`, 3.6):
 *
 * - the person's errand — started in their own turn, on any channel — keeps
 *   `BROWSER_VM_IDLE_MINUTES` after the VM's last use: they may well follow
 *   it up. That is the VM row with no `stop_not_before`, and every VM from
 *   before this rule.
 * - an errand nobody waits for — a schedule's, a background worker's, the
 *   follow-up a browser report's turn makes — stops the VM
 *   `BROWSER_VM_IDLE_BACKGROUND_MINUTES` after its report reached the
 *   conversation.
 * - a run that stopped for the person's code or answer keeps the VM
 *   `BROWSER_VM_IDLE_CODE_MINUTES` after it settled, for the reply.
 *
 * The two later ones set `stop_not_before`, which only ever moves later: an
 * errand nobody waits for, landing on a VM a person's errand kept, first
 * writes down the end of the person's window, and leaves the VM on it while
 * a person's errand is under way or queued. A person's errand — started,
 * followed up, or started later from the queue or for an anti-bot retry —
 * puts the VM back on the person's window, and its report keeps the VM that
 * window after it. Whatever the window, the reconcile never
 * stops a VM with a run open or coming (`lifecycle.ts`, `stopIfIdle`).
 *
 * The writes are bookkeeping around an errand, so none of them fails it: a
 * write that did not land leaves the VM on the window it had.
 */

const minuteMs = 60_000;

function personIdleMs() {
  return env.BROWSER_VM_IDLE_MINUTES * minuteMs;
}

function backgroundIdleMs() {
  return env.BROWSER_VM_IDLE_BACKGROUND_MINUTES * minuteMs;
}

/** The last uses before which a VM counts as unused, per window. */
export function browserVmUnusedBefore(now: Date) {
  return {
    graceBefore: new Date(now.getTime() - backgroundIdleMs()),
    idleBefore: new Date(now.getTime() - personIdleMs()),
  };
}

/**
 * Whether the VM's idle window is over: on the person's window, unused for
 * it; otherwise past `stop_not_before` and unused for the short grace, so a
 * read or a start a moment ago still counts.
 */
export function browserVmIdleStopDue(
  vm: Pick<typeof browserVms.$inferSelect, "lastUsedAt" | "stopNotBefore">,
  now: Date
) {
  const unused = browserVmUnusedBefore(now);
  const usedAt = vm.lastUsedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (vm.stopNotBefore === null) {
    return usedAt <= unused.idleBefore.getTime();
  }
  return (
    vm.stopNotBefore.getTime() <= now.getTime() &&
    usedAt <= unused.graceBefore.getTime()
  );
}

/**
 * An errand is about to start or go on on the workspace's VM: the person's
 * own puts the VM on the person's window; one nobody waits for keeps what
 * is set, with the person's window written down if the VM was on it, and
 * its report sets the stop later (`keepBrowserVmAfterReport`).
 */
export async function keepBrowserVmForErrand(
  workspaceId: string,
  byPerson: boolean,
  now = new Date()
) {
  await bookkeeping(workspaceId, async () => {
    if (byPerson) {
      await clearBrowserVmStopNotBefore(workspaceId, now);
      return;
    }
    // The workspace's first VM errand finds no record yet: it is made here,
    // as the errand would make it, so the short window lands on it.
    await ensureBrowserVmRecord(workspaceId);
    await extendBrowserVmStopNotBefore(
      workspaceId,
      { personIdleMs: personIdleMs(), until: now },
      now
    );
  });
}

/**
 * A VM run settled waiting for the person's code or answer: the VM stays up
 * for the reply until the code wait is over, or longer when something else
 * keeps it. A Browser Use run is not on a VM and changes nothing.
 */
export async function keepBrowserVmForPersonStep(
  runId: string,
  now = new Date()
) {
  if (!isBrowserVmId(runId)) return;
  await bookkeeping(runId, async () => {
    await extendBrowserVmStopNotBefore(
      browserVmWorkspace(runId),
      {
        personIdleMs: personIdleMs(),
        until: new Date(
          now.getTime() + env.BROWSER_VM_IDLE_CODE_MINUTES * minuteMs
        ),
      },
      now
    );
  });
}

/**
 * A VM run's report reached its conversation. A VM on a short window stops
 * a little after the report of an errand nobody waits for, and stays the
 * person's window after the report of the person's own; a VM on the
 * person's window stays on it.
 */
export async function keepBrowserVmAfterReport(
  runId: string,
  now = new Date()
) {
  if (!isBrowserVmId(runId)) return;
  await bookkeeping(runId, async () => {
    const run = await readBrowserRun(runId);
    // A run from before the flag counts as the person's.
    const keepMs =
      run?.startedByPerson === false ? backgroundIdleMs() : personIdleMs();
    await extendBrowserVmStopNotBefore(
      browserVmWorkspace(runId),
      {
        onlyIfSet: true,
        personIdleMs: personIdleMs(),
        until: new Date(now.getTime() + keepMs),
      },
      now
    );
  });
}

/** `id` is the workspace's or the run's, for the log. */
async function bookkeeping(id: string, write: () => Promise<void>) {
  try {
    await write();
  } catch (error) {
    console.warn("[browser-vm] the idle window could not be recorded", {
      cause: error,
      id,
    });
  }
}
