import { z } from "zod";
import { usesBrowserPool } from "@agent/lib/browser-vm/backend";
import { browserVmIdleStopDue } from "@agent/lib/browser-vm/idle";
import {
  BrowserVmWorkerError,
  parkBrowserVmWorker,
  readBrowserVmWorkerHealth,
  resetBrowserVmWorkerProfile,
} from "@agent/lib/browser-vm/worker";
import { recordBrowserSandboxUptime } from "@agent/lib/costs/browser";
import { alertOwner } from "@agent/lib/owner-alert";
import type { browserHosts } from "@db/schema/browser-hosts";
import type { browserVms } from "@db/schema/browser-vms";
import { listBrowserHosts, readBrowserHost } from "@db/services/browser-hosts";
import {
  listWorkspacesHoldingBrowsers,
  workspaceHasPendingBrowserErrand,
} from "@db/services/browser-runs";
import {
  claimBrowserVmLease,
  clearBrowserVmProfileReset,
  deleteBrowserVmRecord,
  listBrowserSandboxesOnHost,
  listOpenBrowserVmRuns,
  listStrandedBrowserSandboxes,
  readBrowserVm,
  releaseBrowserVmLease,
  updateBrowserVm,
} from "@db/services/browser-vms";
import {
  BrowserHostError,
  browserStateSetKey,
  deleteBrowserHostSandbox,
  deleteBrowserSandbox,
  parkBrowserSandbox,
  readBrowserHostCapacity,
  readBrowserSandbox,
  startBrowserSandbox,
} from "./host";
import { placeBrowserSandbox, reconcileBrowserHosts } from "./hosts";
import { browserSandboxId } from "./keys";
import { deleteBrowserStateObjects, listBrowserStateObjects } from "./s3";

/**
 * The life of a pool workspace's browser (docs/browser-pool.md, section 5):
 * another placement of the workspace's own browser, not another backend.
 * The profile ids (`vm:<ws>:p<n>`), the worker, its API and its tokens are
 * those of a workspace VM; only the worker's address differs (the host's,
 * under `/g/<sandbox id>`, `agent/lib/browser-vm/worker.ts`).
 *
 * The `browser_vms` row stays the one record, under the same lease: every
 * step that starts, parks, restores or deletes the sandbox holds it, so one
 * workspace never has two live sandboxes. `sandbox_state` says where the
 * browser is; `state` mirrors it in the VM's words, so everything that only
 * asks whether the browser is up (runs, the queue, the idle windows) reads
 * a sandbox as it reads a VM: `ready` while it runs on a host, `starting`
 * while it starts or restores, `stopping` while it parks, `stopped` while it
 * is on no host.
 *
 * Generations: every start on a host is a new generation (the row's
 * `generation`, which also signs the worker's tokens), and a park writes its
 * set under the sandbox's own generation, so a set is always older than the
 * start that restores it (`hostd` refuses one that is not) and a newer park
 * never writes over the set it came from. Every call to `hostd` carries the
 * generation, and `hostd` refuses an older one.
 *
 * The time a sandbox lives on a host is charged to its workspace from
 * `powered_on_at` (`recordBrowserSandboxUptime`); the accounting never fails
 * a step, and a stretch that could not be recorded is logged and let go.
 */

type BrowserVm = typeof browserVms.$inferSelect;
type BrowserHost = typeof browserHosts.$inferSelect;
type SandboxState = NonNullable<BrowserVm["sandboxState"]>;

/**
 * A start (a restore downloads a set and boots Chrome: up to 4 minutes at
 * `hostd`'s own limits) or a park (freeze, pack and upload: up to 5) is
 * answered inside this, so the step keeps its lease through the call.
 */
const sandboxLeaseMs = 6 * 60_000;
/** Someone else holds the lease: they are starting or parking it already. */
const leaseHeldRetryMs = 15_000;
/** The sandbox is on its way onto a host or off one. */
const transitionRetryMs = 15_000;
/** A start whose answer was lost may still be going: the reconcile reads it. */
const lostStartRetryMs = 30_000;
/** The host had no room after all: the next placement asks it afresh. */
const noRoomRetryMs = 60_000;
/**
 * A start, restore or park `hostd` still reports under way this long after
 * it began is given up on: the sandbox is deleted from the host and goes
 * back to its last set.
 */
const stuckAfterMs = 10 * 60_000;
/** Health checks in a row a running sandbox's worker may miss. */
const missedChecksToDemote = 3;
/** As for a VM: a run this young may still be going on a silent worker. */
const liveRunWindowMs = 30 * 60_000;
/** As for a VM: a run still open after an hour is one nobody read. */
const openRunWindowMs = 60 * 60_000;
/** Stranded sandboxes one reconcile takes back to their sets. */
const reconcileLimit = 20;
const ownerAlertRepeatMs = 6 * 60 * 60_000;

/** What `hostd` says in the JSON of a refusal (`Refused` in `hostd.py`). */
const refusalSchema = z.object({
  error: z.string().optional(),
  generation: z.number().int().nonnegative().optional(),
});

/**
 * Whether the workspace's browser is a sandbox of the pool: a record that
 * already is one, or a workspace in the pool (`usesBrowserPool`) that has no
 * VM of its own. A workspace that has a VM keeps it: its disk holds the
 * person's profile, and moving it into a set is the owner's step
 * (docs/browser-pool.md, stage 5).
 */
export async function inBrowserPool(record: BrowserVm) {
  if (record.sandboxState !== null) return true;
  if (record.vmId !== null || record.state !== "stopped") return false;
  return usesBrowserPool({ workspaceId: record.workspaceId });
}

/**
 * The workspace's sandbox when its worker is up, or how long the errand
 * should wait. A sandbox on no host is placed and started under the lease,
 * right here: from its set in seconds, or fresh; one on its way onto a host
 * or off one is waited for.
 */
export async function ensureBrowserSandbox(
  record: BrowserVm,
  now = new Date()
) {
  if (record.state === "deleting") return starting(transitionRetryMs);
  if (record.sandboxState === "running") return readyForErrand(record, now);
  const claimed = await claimBrowserVmLease(
    record.workspaceId,
    now,
    sandboxLeaseMs
  );
  if (!claimed) return starting(leaseHeldRetryMs);
  try {
    if (claimed.state === "deleting") return starting(transitionRetryMs);
    switch (claimed.sandboxState) {
      case "running": {
        return await readyForErrand(claimed, now);
      }
      case "starting":
      case "restoring":
      case "parking": {
        return starting(transitionRetryMs);
      }
      default: {
        return await bringUp(claimed, now);
      }
    }
  } finally {
    await releaseBrowserVmLease(
      record.workspaceId,
      claimed.leaseUntil ?? undefined
    );
  }
}

/**
 * Look after the pool once a minute: its hosts first, then sandboxes left on
 * a host that failed or went, then whatever a host holds that no record
 * places there. Never throws.
 */
export async function reconcileBrowserPool(now = new Date()) {
  await reconcileBrowserHosts(now);
  try {
    const stranded = await listStrandedBrowserSandboxes(now, reconcileLimit);
    await Promise.all(
      stranded.map(async (row) =>
        reconcileQuietly(row.workspaceId, row.sandboxState, now)
      )
    );
    const hosts = await listBrowserHosts();
    await Promise.all(
      hosts
        .filter((host) => host.state === "ready" || host.state === "draining")
        .map(async (host) => sweepQuietly(host))
    );
  } catch (error) {
    console.warn("[browser-pool] the sandboxes could not be reconciled", {
      cause: error,
    });
  }
}

/**
 * One step on a pool workspace's sandbox, under its lease: follow a start or
 * a park `hostd` has not answered yet, look after a running sandbox (its
 * worker, a forgotten profile, the park when its idle window is over), drop
 * the sets of a forgotten profile, carry on a deletion. A record another
 * step holds is left for the next round.
 */
export async function reconcileBrowserSandbox(
  workspaceId: string,
  now = new Date()
) {
  const claimed = await claimBrowserVmLease(workspaceId, now, sandboxLeaseMs);
  if (!claimed) return;
  try {
    if (claimed.state === "deleting") {
      await removeBrowserSandbox(claimed, now);
      return;
    }
    switch (claimed.sandboxState) {
      case "starting":
      case "restoring": {
        await followStart(claimed, now);
        break;
      }
      case "running": {
        await tendRunning(claimed, now);
        break;
      }
      case "parking": {
        await followPark(claimed, now);
        break;
      }
      case "absent":
      case "parked":
      case "cold":
      case "failed": {
        if (claimed.profileResetPending) {
          await forgetSets(claimed, now, { sandboxState: "absent" });
        }
        break;
      }
      case null: {
        break;
      }
    }
  } finally {
    await releaseBrowserVmLease(workspaceId, claimed.leaseUntil ?? undefined);
  }
}

/**
 * Delete a pool workspace's browser, holding the lease the caller claimed:
 * the sandbox on its host (a host that failed takes it with its disk), every
 * set in Object Storage (`sets/<sandbox id>/`), and then the record. True
 * once all of it is gone; throws while the host or Object Storage cannot be
 * asked, and the record stays `deleting` for the reconcile to finish.
 */
export async function removeBrowserSandbox(vm: BrowserVm, now = new Date()) {
  const { workspaceId } = vm;
  const deleting =
    vm.state === "deleting"
      ? vm
      : await writeHeld(vm, { state: "deleting" }, now);
  const host =
    deleting.hostId === null
      ? undefined
      : await readBrowserHost(deleting.hostId);
  if (
    host?.address !== null &&
    host !== undefined &&
    (host.state === "ready" || host.state === "draining")
  ) {
    try {
      await deleteBrowserSandbox(host, {
        generation: deleting.generation,
        workspaceId,
      });
    } catch (error) {
      // A newer generation on the host is no sandbox of this record: the
      // sweep clears it away once the record is gone.
      if (!(error instanceof BrowserHostError && error.status === 409)) {
        throw error;
      }
    }
  }
  await deleteBrowserStateObjects(`sets/${browserSandboxId(workspaceId)}/`);
  await closeStretch(deleting, now);
  await deleteBrowserVmRecord(workspaceId);
  return true;
}

function starting(retryAfterMs: number) {
  return { kind: "starting" as const, retryAfterMs };
}

function overdue(vm: BrowserVm, now: Date, afterMs: number) {
  return now.getTime() - vm.stateChangedAt.getTime() >= afterMs;
}

/**
 * The running sandbox for an errand when its host still holds it at the
 * address Bro knows and its worker is alive, or a short wait. A host that
 * failed or went is the reconcile's to take the sandbox off; a profile the
 * person forgot is wiped by the reconcile before anything runs on it.
 */
async function readyForErrand(vm: BrowserVm, now: Date) {
  if (vm.profileResetPending) return starting(transitionRetryMs);
  if ((await holdingHost(vm)) === undefined) {
    return starting(transitionRetryMs);
  }
  if ((await aliveWorker(vm)) === undefined) {
    return starting(transitionRetryMs);
  }
  const touched = await updateBrowserVm(
    vm.workspaceId,
    { lastUsedAt: now },
    now
  );
  return touched.state === "ready" && touched.sandboxState === "running"
    ? { kind: "ready" as const, vm: touched }
    : starting(transitionRetryMs);
}

/**
 * Place the sandbox on a host and start it there under a new generation:
 * restoring the snapshot of a parked set, from the profile alone of a `cold`
 * one, fresh otherwise — and fresh when the person asked to forget their
 * sign-ins, whose sets go first. The host and the new state are written
 * before `hostd` is asked: that write keeps an empty host from being deleted
 * under the start, and a start whose answer is lost is read back by it.
 */
async function bringUp(record: BrowserVm, now: Date) {
  const placed = await placeBrowserSandbox(now);
  if (placed.kind === "starting") return starting(placed.retryAfterMs);
  const { host } = placed;
  const vm = record.profileResetPending
    ? await forgetSets(record, now, { sandboxState: "absent" })
    : record;
  const from = setOf(vm);
  const resting = vm.sandboxState ?? "absent";
  const generation = Math.max(vm.generation, vm.snapshotGeneration ?? 0) + 1;
  // A set that failed is given up: the start is fresh, the record keeps no
  // set, and the next park prunes it (`pruneSets`). A start that fails on
  // the host then reads as the host's trouble, not the set's (`fallBack`).
  const givenUp =
    resting === "failed"
      ? {
          snapshotChunks: null,
          snapshotFormat: null,
          snapshotGeneration: null,
          snapshotKey: null,
        }
      : {};
  const placedRow = await writeHeld(
    vm,
    {
      ...givenUp,
      generation,
      healthFailures: 0,
      host: host.address,
      hostId: host.id,
      poweredOnAt: now,
      recoveries: 0,
      // A restore of a snapshot, or a start fresh or from the profile alone:
      // what a failure falls back from.
      sandboxState: from?.snapshot === true ? "restoring" : "starting",
      state: "starting",
    },
    now
  );
  let sandbox: Awaited<ReturnType<typeof startBrowserSandbox>>;
  try {
    sandbox = await startBrowserSandbox(host, {
      from,
      generation,
      workspaceId: vm.workspaceId,
    });
  } catch (error) {
    if (error instanceof BrowserHostError) {
      return starting(await startRefused(placedRow, error, resting, now));
    }
    // The answer was lost: the start may be going on, and the reconcile
    // reads it back (`followStart`).
    console.warn("[browser-pool] a sandbox start got no answer", {
      cause: error,
      workspaceId: vm.workspaceId,
    });
    return starting(lostStartRetryMs);
  }
  if (sandbox.state !== "running" || sandbox.generation !== generation) {
    return starting(transitionRetryMs);
  }
  const running = await markRunning(placedRow, sandbox.fallback, now);
  return { kind: "ready" as const, vm: running };
}

/**
 * The set a start goes from: a parked one's snapshot, a cold one's profile.
 * A sandbox that failed from its set starts fresh (the owner was told).
 */
function setOf(vm: BrowserVm) {
  if (vm.snapshotKey === null || vm.snapshotChunks === null) return undefined;
  if (vm.sandboxState === "parked") {
    return { chunks: vm.snapshotChunks, key: vm.snapshotKey, snapshot: true };
  }
  if (vm.sandboxState === "cold") {
    return { chunks: vm.snapshotChunks, key: vm.snapshotKey, snapshot: false };
  }
  return undefined;
}

async function markRunning(
  vm: BrowserVm,
  fallback: string | null | undefined,
  now: Date
) {
  return writeHeld(
    vm,
    {
      healthFailures: 0,
      lastError:
        fallback === null || fallback === undefined
          ? null
          : `The snapshot was not restored (${fallback}); the sandbox started from its profile.`,
      lastUsedAt: now,
      sandboxState: "running",
      state: "ready",
    },
    now
  );
}

/**
 * A start `hostd` refused, and how long the errand should wait. No room, a
 * root it lacks or a newer generation it knows: back where the sandbox was,
 * to be placed again. A start that did not come up from what it was given
 * falls back to less next time (`fallBack`).
 */
async function startRefused(
  vm: BrowserVm,
  error: BrowserHostError,
  resting: SandboxState,
  now: Date
) {
  const refusal = refusalOf(error);
  if (error.status === 409 && refusal.generation !== undefined) {
    // The host knows a newer generation of this sandbox: the next start
    // goes past it.
    await offHost(
      vm,
      {
        generation: Math.max(vm.generation, refusal.generation),
        lastError: error.message,
        sandboxState: resting,
      },
      now
    );
    return transitionRetryMs;
  }
  if (
    error.status === 507 ||
    (error.status === 409 && refusal.error?.includes("rootfs") === true)
  ) {
    await offHost(vm, { lastError: error.message, sandboxState: resting }, now);
    return noRoomRetryMs;
  }
  await fallBack(vm, error.message, now);
  return transitionRetryMs;
}

/**
 * A start that failed on the host: a snapshot that did not restore leaves
 * the profile of its set (`cold`); a set whose profile did not come up
 * either is `failed`, the owner is told, and the next errand starts fresh;
 * a fresh start (no set on record) that failed is the host's trouble, and
 * the owner is told.
 */
async function fallBack(vm: BrowserVm, reason: string, now: Date) {
  const hasSet = vm.snapshotKey !== null;
  const next: SandboxState =
    vm.sandboxState === "restoring" ? "cold" : hasSet ? "failed" : "absent";
  await offHost(vm, { lastError: reason, sandboxState: next }, now);
  if (vm.sandboxState === "restoring") return;
  await alert(
    `browser-sandbox-failed:${vm.workspaceId}`,
    hasSet
      ? [
          `Браузер воркспейса ${vm.workspaceId} не поднялся из последнего набора: ${reason.slice(0, 300)}`,
          "Следующее поручение начнёт с пустого профиля: входы на сайты придётся повторить. Набор в Object Storage пока цел.",
        ].join("\n")
      : `Хост пула браузеров не смог поднять песочницу воркспейса ${vm.workspaceId}: ${reason.slice(0, 300)}`
  );
}

/**
 * A start or restore `hostd` has not answered: read it back. Running, it is
 * ready; failed, it falls back; missing or older, the start never reached
 * the host and the sandbox goes back to its set; still under way long after
 * it began, it is deleted there and goes back too.
 */
async function followStart(vm: BrowserVm, now: Date) {
  const host = await holdingHost(vm);
  if (host === undefined) {
    await backToSet(vm, now, "The sandbox's host failed or went.");
    return;
  }
  let sandbox: Awaited<ReturnType<typeof readBrowserSandbox>>;
  try {
    sandbox = await readBrowserSandbox(host, vm.workspaceId);
  } catch (error) {
    if (overdue(vm, now, stuckAfterMs)) {
      await abandonOnHost(vm, host, now, "The host did not answer the start.");
    }
    console.warn("[browser-pool] the start could not be read back", {
      cause: error,
      workspaceId: vm.workspaceId,
    });
    return;
  }
  if (sandbox === undefined || sandbox.generation < vm.generation) {
    await backToSet(vm, now, "The start never reached the host.");
    return;
  }
  if (sandbox.generation > vm.generation) {
    await offHost(
      vm,
      {
        generation: sandbox.generation,
        lastError: "The host knows a newer generation of the sandbox.",
        sandboxState: restingOf(vm),
      },
      now
    );
    return;
  }
  switch (sandbox.state) {
    case "running": {
      await markRunning(vm, sandbox.fallback, now);
      return;
    }
    case "failed": {
      await fallBack(vm, sandbox.error ?? "The sandbox did not start.", now);
      return;
    }
    case "starting":
    case "restoring": {
      if (overdue(vm, now, stuckAfterMs)) {
        await abandonOnHost(vm, host, now, "The start never finished.");
      }
      return;
    }
    default: {
      await backToSet(vm, now, `The host has the sandbox ${sandbox.state}.`);
    }
  }
}

/**
 * A running sandbox the reconcile looks at: its host must still hold it and
 * its worker answer (a few missed checks are forgiven, and a run that may be
 * going keeps it); a profile the person forgot is wiped with the sets that
 * hold it; an idle one is parked.
 */
async function tendRunning(vm: BrowserVm, now: Date) {
  const host = await holdingHost(vm);
  if (host === undefined) {
    await backToSet(vm, now, "The sandbox's host failed or went.");
    return;
  }
  const health = await aliveWorker(vm);
  if (health === undefined) {
    const missed = vm.healthFailures + 1;
    if (
      missed < missedChecksToDemote ||
      (await hasOpenRunSince(vm.workspaceId, now.getTime() - liveRunWindowMs))
    ) {
      await writeHeld(vm, { healthFailures: missed }, now);
      return;
    }
    await abandonOnHost(
      vm,
      host,
      now,
      `The worker missed ${String(missed)} health checks in a row.`
    );
    return;
  }
  let current = vm;
  if (vm.healthFailures > 0) {
    current = await writeHeld(vm, { healthFailures: 0 }, now);
  }
  // A run holds the browser: neither idle nor free to be wiped.
  if (health.busy) return;
  if (current.profileResetPending) {
    await resetBrowserVmWorkerProfile(current);
    current = await forgetSets(current, now, {});
  }
  await parkIfIdle(current, host, now);
}

/**
 * Park a sandbox whose idle window is over (`agent/lib/browser-vm/idle.ts`,
 * the same windows a VM stops by) and that no run, kept page or waiting
 * errand needs: the worker drops its secrets (and refuses while a run is
 * open), `hostd` freezes the sandbox into a new set under its generation,
 * and the record keeps the set. The state is written first, so an errand
 * that moved the window in between is seen and keeps the sandbox. A park
 * `hostd` refused leaves the sandbox running there (it restores it in
 * place), and the next round tries again; a park never runs under a run.
 */
async function parkIfIdle(vm: BrowserVm, host: BrowserHost, now: Date) {
  const { workspaceId } = vm;
  if (!browserVmIdleStopDue(vm, now)) return;
  if (await hasOpenRunSince(workspaceId, now.getTime() - openRunWindowMs)) {
    return;
  }
  const holding = await listWorkspacesHoldingBrowsers([workspaceId], now);
  if (holding.length > 0) return;
  if (await workspaceHasPendingBrowserErrand(workspaceId, now)) return;
  const parking = await writeHeld(
    vm,
    { sandboxState: "parking", state: "stopping" },
    now
  );
  if (!browserVmIdleStopDue(parking, now)) {
    await writeHeld(vm, { sandboxState: "running", state: "ready" }, now);
    return;
  }
  try {
    await parkBrowserVmWorker(parking);
  } catch (error) {
    // Busy with a run after all (409), or silent: it runs on as it was.
    await writeHeld(vm, { sandboxState: "running", state: "ready" }, now);
    if (!(error instanceof BrowserVmWorkerError && error.status === 409)) {
      console.warn("[browser-pool] the worker did not drop its secrets", {
        cause: error,
        workspaceId,
      });
    }
    return;
  }
  let parked: Awaited<ReturnType<typeof parkBrowserSandbox>>;
  try {
    parked = await parkBrowserSandbox(host, {
      generation: parking.generation,
      workspaceId,
    });
  } catch (error) {
    console.warn("[browser-pool] the park did not go through", {
      cause: error,
      workspaceId,
    });
    // A refusal says what the host did with the sandbox; a lost answer is
    // read back by the reconcile.
    if (error instanceof BrowserHostError) await followPark(parking, now);
    return;
  }
  await recordParked(parking, parked, now);
}

/**
 * A park `hostd` has not answered, or refused: read it back. Parked under
 * this generation, the set is recorded; running, the park did not go
 * through and the sandbox runs on; still parking long after, or failed or
 * missing, the sandbox is deleted there and goes back to its last set.
 */
async function followPark(vm: BrowserVm, now: Date) {
  const host = await holdingHost(vm);
  if (host === undefined) {
    await backToSet(vm, now, "The sandbox's host failed or went.");
    return;
  }
  let sandbox: Awaited<ReturnType<typeof readBrowserSandbox>>;
  try {
    sandbox = await readBrowserSandbox(host, vm.workspaceId);
  } catch (error) {
    console.warn("[browser-pool] the park could not be read back", {
      cause: error,
      workspaceId: vm.workspaceId,
    });
    return;
  }
  if (sandbox?.generation === vm.generation) {
    if (sandbox.state === "parked" && sandbox.parked) {
      await recordParked(vm, sandbox.parked, now);
      return;
    }
    if (sandbox.state === "running") {
      await writeHeld(
        vm,
        {
          lastError: "The park did not go through; the sandbox runs on.",
          sandboxState: "running",
          state: "ready",
        },
        now
      );
      return;
    }
    if (sandbox.state === "parking" && !overdue(vm, now, stuckAfterMs)) {
      return;
    }
  }
  await abandonOnHost(vm, host, now, "The sandbox was lost while parking.");
}

/**
 * The set a park wrote is the sandbox's now: the record keeps its key,
 * generation, chunks and snapshot format, the sandbox is off the host, and
 * every older set of the workspace goes.
 */
async function recordParked(
  vm: BrowserVm,
  parked: Pick<
    Awaited<ReturnType<typeof parkBrowserSandbox>>,
    "chunks" | "format" | "generation"
  >,
  now: Date
) {
  const key = browserStateSetKey(vm.workspaceId, parked.generation);
  await offHost(
    vm,
    {
      lastError: null,
      sandboxState: "parked",
      snapshotChunks: parked.chunks,
      snapshotFormat: JSON.stringify(parked.format),
      snapshotGeneration: parked.generation,
      snapshotKey: key,
    },
    now
  );
  await pruneSets(vm.workspaceId, key);
}

/**
 * Delete the workspace's sets but the one kept: older sets, and chunks of
 * parks that never wrote their manifest. Best effort: a set left over is
 * only storage, and the workspace's deletion takes every set.
 */
async function pruneSets(workspaceId: string, keep: string) {
  const prefix = `sets/${browserSandboxId(workspaceId)}/`;
  try {
    const keys = await listBrowserStateObjects(prefix);
    const others = new Set(
      keys
        .filter((key) => !key.startsWith(keep))
        .map(
          (key) => `${prefix}${key.slice(prefix.length).split("/")[0] ?? ""}/`
        )
        .filter((set) => set !== `${prefix}/`)
    );
    await Promise.all(
      [...others].map(async (set) => deleteBrowserStateObjects(set))
    );
  } catch (error) {
    console.warn("[browser-pool] older sets could not be deleted", {
      cause: error,
      workspaceId,
    });
  }
}

/**
 * Forget the person's sign-ins held in Object Storage: every set of the
 * workspace goes, the record keeps none, and the pending wipe of this
 * profile generation is done (a forget that came in meanwhile keeps its
 * flag). `patch` moves a sandbox on no host back to `absent`.
 */
async function forgetSets(
  vm: BrowserVm,
  now: Date,
  patch: Parameters<typeof updateBrowserVm>[1]
) {
  await deleteBrowserStateObjects(`sets/${browserSandboxId(vm.workspaceId)}/`);
  const cleared = await writeHeld(
    vm,
    {
      snapshotChunks: null,
      snapshotFormat: null,
      snapshotGeneration: null,
      snapshotKey: null,
      ...patch,
    },
    now
  );
  await clearBrowserVmProfileReset(vm.workspaceId, vm.profileGeneration, now);
  return (await readBrowserVm(vm.workspaceId)) ?? cleared;
}

/**
 * Delete the sandbox from a host that still answers, and take it back to
 * its last set. A delete that did not get through leaves a sandbox no record
 * places there, which the sweep clears away.
 */
async function abandonOnHost(
  vm: BrowserVm,
  host: BrowserHost,
  now: Date,
  reason: string
) {
  try {
    await deleteBrowserSandbox(host, {
      generation: vm.generation,
      workspaceId: vm.workspaceId,
    });
  } catch (error) {
    console.warn("[browser-pool] the sandbox could not be deleted", {
      cause: error,
      workspaceId: vm.workspaceId,
    });
  }
  await backToSet(vm, now, reason);
}

/** Off its host, back to its last set (or none): the next errand restores it. */
async function backToSet(vm: BrowserVm, now: Date, reason: string) {
  await offHost(vm, { lastError: reason, sandboxState: restingOf(vm) }, now);
}

function restingOf(vm: BrowserVm): SandboxState {
  return vm.snapshotKey === null ? "absent" : "parked";
}

/**
 * Write the sandbox off its host: the stretch it lived there is charged
 * first, and the record keeps no host.
 */
async function offHost(
  vm: BrowserVm,
  patch: Parameters<typeof updateBrowserVm>[1],
  now: Date
) {
  await closeStretch(vm, now);
  return writeHeld(
    vm,
    {
      healthFailures: 0,
      host: null,
      hostId: null,
      poweredOnAt: null,
      state: "stopped",
      ...patch,
    },
    now
  );
}

/** Charge the stretch the sandbox lived on its host. Never throws. */
async function closeStretch(vm: BrowserVm, now: Date) {
  if (vm.poweredOnAt === null) return;
  try {
    const recorded = await recordBrowserSandboxUptime(
      vm.workspaceId,
      vm.poweredOnAt,
      now
    );
    if (!recorded) throw new Error("The stretch was not recorded.");
  } catch (error) {
    console.warn("[usage-costs] the sandbox's time was not recorded", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: vm.workspaceId,
    });
  }
}

/**
 * The host the record places the sandbox on, while it still holds it: in
 * service (`ready` or `draining`) at the address Bro knows. An address of a
 * host that failed or went may be another VM's by now, and nothing goes
 * there.
 */
async function holdingHost(vm: BrowserVm) {
  if (vm.hostId === null || vm.host === null) return undefined;
  const host = await readBrowserHost(vm.hostId);
  if (host?.address !== vm.host) return undefined;
  return host.state === "ready" || host.state === "draining" ? host : undefined;
}

/**
 * The worker's health when it is alive: set up with Chrome answering, or
 * busy with a run. Undefined when it did not answer or is not alive.
 */
async function aliveWorker(vm: BrowserVm) {
  if (vm.host === null) return undefined;
  try {
    const health = await readBrowserVmWorkerHealth(vm);
    return health.busy || (health.configured && health.chrome)
      ? health
      : undefined;
  } catch {
    return undefined;
  }
}

async function hasOpenRunSince(workspaceId: string, since: number) {
  const openRuns = await listOpenBrowserVmRuns(workspaceId);
  return openRuns.some((run) => run.createdAt.getTime() > since);
}

/**
 * Clear away what a ready host holds that no record places there: a start
 * Bro gave up on, a sandbox left behind by a delete that did not get
 * through, a failed one whose profile `hostd` keeps until it is deleted.
 * The host is read before the records, so a start written a moment ago is
 * never taken for left over. Parked records hold nothing and stay.
 */
async function sweepBrowserHost(host: BrowserHost) {
  const capacity = await readBrowserHostCapacity(host);
  const placed = new Set(
    (await listBrowserSandboxesOnHost(host.id)).map((row) =>
      browserSandboxId(row.workspaceId)
    )
  );
  await Promise.all(
    capacity.sandboxes
      .filter((sandbox) => sandbox.state !== "parked")
      .filter((sandbox) => !placed.has(sandbox.id))
      .map(async (sandbox) => {
        console.warn("[browser-pool] clearing a sandbox nobody places", {
          hostId: host.id,
          sandbox: sandbox.id,
          state: sandbox.state,
        });
        await deleteBrowserHostSandbox(host, {
          generation: sandbox.generation,
          id: sandbox.id,
        });
      })
  );
}

async function sweepQuietly(host: BrowserHost) {
  try {
    await sweepBrowserHost(host);
  } catch (error) {
    console.warn("[browser-pool] the host could not be swept", {
      cause: error,
      hostId: host.id,
    });
  }
}

async function reconcileQuietly(
  workspaceId: string,
  state: BrowserVm["sandboxState"],
  now: Date
) {
  try {
    await reconcileBrowserSandbox(workspaceId, now);
  } catch (error) {
    console.warn("[browser-pool] the sandbox could not be reconciled", {
      cause: error,
      state,
      workspaceId,
    });
  }
}

function refusalOf(error: BrowserHostError) {
  try {
    return refusalSchema.safeParse(JSON.parse(error.body)).data ?? {};
  } catch {
    return {};
  }
}

/**
 * Write the record as the holder of the lease `vm` was claimed under: a
 * step that outlived its lease while another took the sandbox over throws
 * here, before it acts on what it read.
 */
async function writeHeld(
  vm: BrowserVm,
  patch: Parameters<typeof updateBrowserVm>[1],
  now: Date
) {
  return updateBrowserVm(
    vm.workspaceId,
    patch,
    now,
    vm.leaseUntil ?? undefined
  );
}

/** Never throws: an errand must not fail because the owner was not told. */
async function alert(key: string, text: string) {
  try {
    await alertOwner(key, text, { repeatAfterMs: ownerAlertRepeatMs });
  } catch (error) {
    console.warn("[browser-pool] the owner could not be alerted", {
      cause: error,
      key,
    });
  }
}
