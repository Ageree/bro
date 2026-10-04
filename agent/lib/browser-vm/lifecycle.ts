import { setTimeout as sleep } from "node:timers/promises";
import {
  ensureBrowserSandbox,
  inBrowserPool,
  reconcileBrowserPool,
  reconcileBrowserSandbox,
  removeBrowserSandbox,
} from "@agent/lib/browser-pool/sandbox";
import { BrowserUseError } from "@agent/lib/browser-use/errors";
import { recordBrowserVmUptime } from "@agent/lib/costs/browser";
import { alertOwner, clearOwnerAlert } from "@agent/lib/owner-alert";
import type { browserVms } from "@db/schema/browser-vms";
import {
  listWorkspacesHoldingBrowsers,
  workspaceHasPendingBrowserErrand,
} from "@db/services/browser-runs";
import {
  claimBrowserVmLease,
  clearBrowserVmProfileReset,
  deleteBrowserVmRecord,
  ensureBrowserVmRecord,
  listBrowserVmsToReconcile,
  listOpenBrowserVmRuns,
  readBrowserVm,
  releaseBrowserVmLease,
  updateBrowserVm,
} from "@db/services/browser-vms";
import { usesBrowserPool } from "./backend";
import {
  CloudRuError,
  CloudRuUnsentError,
  createCloudRuVm,
  deleteCloudRuBackupsOf,
  deleteCloudRuFloatingIp,
  deleteCloudRuVm,
  findCloudRuVmByName,
  readCloudRuVm,
  setCloudRuVmPower,
} from "./cloudru";
import { browserVmIdleStopDue, browserVmUnusedBefore } from "./idle";
import { browserVmProxy, browserVmProxySession } from "./proxy";
import {
  browserVmIdleForWorker,
  browserVmWorkerDue,
  browserVmWorkerRollingOut,
  rollOutBrowserVmWorker,
} from "./rollout";
import { browserVmCloudInit } from "./token";
import {
  controlBrowserVmWorkerChrome,
  readBrowserVmWorkerHealth,
  resetBrowserVmWorkerProfile,
  setBrowserVmWorkerProxy,
} from "./worker";

/**
 * The life of a workspace's browser VM: created on its first errand, powered
 * on for the next one, stopped once idle, deleted with the workspace. The
 * disk is the profile — the person's sign-ins live in the Chrome profile on
 * it — so a VM that ever came up is stopped and started again, never
 * replaced behind the person's back.
 *
 * Every step that creates, powers or deletes the VM runs under the record's
 * lease, and writes the record only as its holder (`writeHeld`): an errand,
 * the poller's reconcile and a deletion may all reach for one VM, and two
 * creations would leave a billed VM nobody knows of.
 */

type BrowserVm = typeof browserVms.$inferSelect;
type CloudVm = NonNullable<Awaited<ReturnType<typeof readCloudRuVm>>>;

/** The states in which Cloud.ru bills the VM's compute. */
const poweredStates = new Set<BrowserVm["state"]>([
  "creating",
  "starting",
  "ready",
  "stopping",
]);

/** A create, a power change or a deletion request is answered well inside this. */
const leaseMs = 2 * 60_000;
/** A new VM boots, runs its cloud-init and starts Chrome in two to three minutes. */
const createRetryMs = 180_000;
/** A stopped VM is back with its worker in about a minute. */
const powerOnRetryMs = 60_000;
/** Someone else holds the lease: they are already bringing the VM up. */
const leaseHeldRetryMs = 60_000;
/** The VM is on its way up or down already. */
const transitionRetryMs = 45_000;
/** A quota does not free itself in a minute; the owner has been told. */
const quotaRetryMs = 10 * 60_000;
/** Cloud.ru could not be asked at all (its key, IAM, the project): soon again. */
const unsentRetryMs = 60_000;
/**
 * A VM with no healthy worker this long after it was started is rebooted
 * once. A healthy one answers in about a minute (63–113 s from a warmed
 * image); the first boot that hangs (`initramfs`) never does, and only the
 * reboot brings it up, so waiting longer only delays the person's errand.
 * A VM Cloud.ru still lays the image out for is not `running` yet, and the
 * watchdog leaves it alone.
 */
const rebootAfterMs = 4 * 60_000;
/** ...and given up on this long after it, for the owner to look at. */
const failAfterMs = 20 * 60_000;
/**
 * A power-off or a deletion Cloud.ru has not carried out this long after it
 * was asked for goes to the owner.
 */
const settleFailAfterMs = 15 * 60_000;
/**
 * Health checks in a row a ready VM's worker may miss before the watchdog
 * takes the VM over. The reconcile checks once a minute, so a worker that
 * is slow for a moment keeps its VM.
 */
const missedChecksToDemote = 3;
/**
 * A run this young may still be going on a VM whose worker does not answer
 * (a health check that timed out under the run's load, say), and a reboot
 * or a give-up would end it.
 */
const liveRunWindowMs = 30 * 60_000;
/** The proxy exit is checked again when the last check is older than this. */
const exitCheckMs = 30 * 60_000;
/** Sticky sessions tried after the first, for an exit inside Russia. */
const exitRotations = 3;
// A residential exit this slow made the same Wildberries page take a minute
// instead of three seconds: it is moved while a better one may be had.
const slowExitMbps = 2;
const slowExitLatencyMs = 3_000;
/** Every errand waits on the same exit, so it is tried again in a few minutes. */
const noExitRetryMs = 5 * 60_000;
/** The VMs one reconcile looks at; the poller comes back every minute. */
const reconcileLimit = 20;
/**
 * The worker ends a run after 25 minutes, and a restart fails every run it
 * finds open. A record still open after an hour is one nobody read to its
 * end, and it must not keep a VM up forever.
 */
const openRunWindowMs = 60 * 60_000;
const ownerAlertRepeatMs = 6 * 60 * 60_000;
/** The owner's alert that the residential proxy refuses Bro's login. */
const proxyAlertKey = "browser-vm-proxy";
/**
 * A deletion waits this long for an errand's or the reconcile's step on the
 * VM to end: each holds the lease for one step, seconds as a rule.
 */
const deletionLeaseWaitMs = 15_000;
const deletionLeasePollMs = 1_000;
/**
 * A floating IP's address "comes a little after the VM itself" (`cloudVmOf`):
 * a VM read moments after it was created, or right when its stuck create is
 * given up on, can still show none even though Cloud.ru is attaching one.
 * This is how long that is given to settle before its id is let go for good.
 */
const floatingIpSettleAttempts = 5;
const floatingIpSettlePollMs = 2_000;

/**
 * Write down that the VM is gone from Cloud.ru — deleted by hand, say: the
 * next errand creates a new one. Its public address may have outlived it
 * and is billed on its own, so it is released first; one that could not be
 * keeps its id in the record, and the next step on the VM tries again. The
 * profile went with the disk, so the profile generation moves on and the
 * sign-ins Bro recorded against the old one read as forgotten.
 */
async function forgetGoneVm(
  vm: BrowserVm,
  now: Date,
  patch: Parameters<typeof updateBrowserVm>[1] = {}
) {
  await Promise.all(
    present([vm.floatingIpId]).map(async (id) => deleteCloudRuFloatingIp(id))
  );
  // The disk itself is gone with the VM, but a backup taken of it is a
  // separate Cloud.ru resource that outlives it and keeps billing.
  await deleteCloudRuBackupsOf(present([vm.bootDiskId]));
  return writeHeld(
    vm,
    {
      bootDiskId: null,
      floatingIpId: null,
      givenUpAt: null,
      host: null,
      profileGeneration: vm.profileGeneration + 1,
      profileResetPending: false,
      state: "stopped",
      vmId: null,
      ...patch,
    },
    now
  );
}

/**
 * Hand a pool workspace's VM that is gone from Cloud.ru over to the pool
 * (docs/browser-pool.md, stage 5): the caller made sure it is gone and holds
 * the lease. What `forgetGoneVm` does — its address and the backups of its
 * disk released, the profile generation moved on, since the profile went
 * with the disk — and every field that still names the VM cleared, so the
 * record reads as a workspace with no VM (`inBrowserPool`) and its next
 * start is a fresh sandbox. The sticky proxy session stays. The VM's last
 * stretch that could not be recorded is tried once more, as a deletion
 * does (`closeRemovedUptime`); one that still cannot be is let go, logged,
 * rather than charged later as the sandbox's.
 */
async function handOverGoneVm(vm: BrowserVm, now: Date) {
  const handed = await forgetGoneVm(vm, now, {
    healthFailures: 0,
    image: null,
    lastError: null,
    proxyExit: null,
    recoveries: 0,
    vmName: null,
    workerFailedVersion: null,
    workerRolloutAt: null,
  });
  console.info("[browser-pool] a gone VM was handed over to the pool", {
    vmId: vm.vmId,
    vmName: vm.vmName,
    workspaceId: vm.workspaceId,
  });
  if (handed.poweredOnAt === null) return handed;
  if (!(await closeRemovedUptime(handed, now))) {
    console.warn("[usage-costs] the gone VM's last stretch was not recorded", {
      poweredOnAt: handed.poweredOnAt.toISOString(),
      workspaceId: vm.workspaceId,
    });
  }
  return updateBrowserVm(
    vm.workspaceId,
    { poweredOnAt: null },
    now,
    vm.leaseUntil ?? undefined
  );
}

/** What Cloud.ru did not answer: nothing is handed over on it. */
const unanswered = Symbol("unanswered");

async function askCloudRu<T>(workspaceId: string, ask: () => Promise<T>) {
  try {
    return await ask();
  } catch (error) {
    console.warn("[browser-pool] Cloud.ru could not confirm the VM gone", {
      cause: error,
      workspaceId,
    });
    return unanswered;
  }
}

/**
 * A pool workspace's record names a VM Cloud.ru does not know by its id,
 * while another VM carries its name: nothing is created, taken over or
 * handed over behind it, and the owner is asked to sort it out (the alert
 * repeats at most every few hours).
 */
async function alertNamedVm(vm: BrowserVm, byName: CloudVm) {
  await alert(
    `browser-pool-handover:${vm.workspaceId}`,
    [
      `Воркспейс ${vm.workspaceId} в пуле браузеров, но в Cloud.ru есть VM ${byName.id} с его именем ${vm.vmName ?? "?"}, а запись Бро называет другую (${vm.vmId ?? "?"}).`,
      "Поручения ждут. Удали эту VM в консоли Cloud.ru (с диском и адресом), и следующее поручение пойдёт в пул.",
    ].join("\n")
  );
}

/**
 * A VM Cloud.ru no longer knows by its id, found by the reconcile: a pool
 * workspace's is handed over to the pool once its name finds nothing
 * either, anyone else's is forgotten as before. The reconcile does not wait
 * for runs: a gone VM's runs are over. A pool workspace's VM that its name
 * still finds is left as it is, with the owner told, and so is one
 * Cloud.ru could not be asked about: the next round asks again.
 */
async function forgetGone(
  vm: BrowserVm,
  now: Date,
  patch: { readonly lastError?: string | null } = {}
) {
  if (!(await usesBrowserPool({ workspaceId: vm.workspaceId }))) {
    await forgetGoneVm(vm, now, patch);
    return;
  }
  const { vmName } = vm;
  const byName = await askCloudRu(vm.workspaceId, async () =>
    vmName === null ? undefined : findCloudRuVmByName(vmName)
  );
  if (byName === unanswered) return;
  if (byName !== undefined) {
    console.warn("[browser-pool] the VM is gone by its id, not its name", {
      vmName,
      workspaceId: vm.workspaceId,
    });
    await alertNamedVm(vm, byName);
    return;
  }
  await handOverGoneVm(vm, now);
}

/**
 * An errand's step on a pool workspace's record that still names a VM of
 * its own. A VM Cloud.ru still has — by its id, or by its name when a
 * create lost its answer before the id was known — is started as before
 * and stays the workspace's browser. One gone by its id and by its name is
 * handed over to the pool, and the errand goes on to a sandbox, unless a
 * run may still be open on it or a run holds its page: those are checked
 * before the name is asked for, so a waiting errand asks Cloud.ru once per
 * try. A failure to ask hands nothing over. How long the errand waits, or
 * the handed-over record.
 */
async function handOverForErrand(vm: BrowserVm, now: Date) {
  const { workspaceId } = vm;
  const own = await askCloudRu(workspaceId, async () => cloudVmOf(vm));
  if (own === unanswered) return starting(unsentRetryMs);
  // Started outside the ask: a failed power-on or a lost lease is the
  // errand's error, as for any VM.
  if (own !== undefined) {
    const located =
      vm.vmId === null
        ? await writeHeld(
            vm,
            {
              bootDiskId: own.bootDiskId ?? vm.bootDiskId,
              floatingIpId: own.floatingIpId ?? vm.floatingIpId,
              host: own.host ?? vm.host,
              vmId: own.id,
            },
            now
          )
        : vm;
    return starting(await startVm(located, own, now));
  }
  if (
    (await hasOpenRunSince(workspaceId, now.getTime() - openRunWindowMs)) ||
    (await listWorkspacesHoldingBrowsers([workspaceId], now)).length > 0
  ) {
    return starting(transitionRetryMs);
  }
  const { vmId, vmName } = vm;
  // A record with no id was looked up by its name above.
  const byName = await askCloudRu(workspaceId, async () =>
    vmId === null || vmName === null ? undefined : findCloudRuVmByName(vmName)
  );
  if (byName === unanswered) return starting(unsentRetryMs);
  if (byName !== undefined) {
    await alertNamedVm(vm, byName);
    return starting(quotaRetryMs);
  }
  return { kind: "handed" as const, vm: await handOverGoneVm(vm, now) };
}

/**
 * Write the record as the holder of the lease `vm` was claimed under. A step
 * that outlived its lease while another caller took the VM over throws here,
 * before it asks Cloud.ru for anything on the strength of what it read.
 */
async function writeHeld(
  vm: BrowserVm,
  patch: Parameters<typeof updateBrowserVm>[1],
  now: Date
) {
  const leaseUntil = vm.leaseUntil ?? undefined;
  const closed = await closeUptime(vm.workspaceId, patch, now);
  const row = await updateBrowserVm(
    vm.workspaceId,
    closed ? { ...patch, poweredOnAt: null } : patch,
    now,
    leaseUntil
  );
  // A VM on its way up, up or on its way down bills from the first time Bro
  // writes it so (the migration stamped the VMs already on).
  if (row.poweredOnAt !== null || !poweredStates.has(row.state)) return row;
  try {
    return await updateBrowserVm(
      vm.workspaceId,
      { poweredOnAt: now },
      now,
      leaseUntil
    );
  } catch (error) {
    // The accounting never fails a step on the VM.
    console.warn("[usage-costs] the VM's power-on was not written down", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: vm.workspaceId,
    });
    return row;
  }
}

/**
 * Whether Cloud.ru no longer bills the VM's compute: it is off, or a create
 * or a give-up left no VM behind.
 */
function uptimeEnded(state: BrowserVm["state"], vmId: string | null) {
  return state === "stopped" || (state === "failed" && vmId === null);
}

/**
 * Record the stretch the VM was on when this write ends it, or when an
 * earlier write ended it but could not record it (the end is then when the
 * record took that state), and say whether the write may clear its start.
 * The start is read afresh: a step may carry a row read before it powered
 * on. A stretch that could not be recorded keeps its start for the next
 * write to try again, unless the VM is on its way up again: the old stretch
 * is then let go (logged), rather than billed through the time it was off.
 * An unreadable record leaves the clock as it is.
 */
async function closeUptime(
  workspaceId: string,
  patch: Parameters<typeof updateBrowserVm>[1],
  now: Date
) {
  let row: BrowserVm | undefined;
  try {
    row = await readBrowserVm(workspaceId);
  } catch (error) {
    console.warn("[usage-costs] the VM's power-on could not be read", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId,
    });
    return false;
  }
  if (row?.poweredOnAt === null || row?.poweredOnAt === undefined) return false;
  const endedBefore = uptimeEnded(row.state, row.vmId);
  const endsNow = uptimeEnded(
    patch.state ?? row.state,
    patch.vmId === undefined ? row.vmId : patch.vmId
  );
  if (!endedBefore && !endsNow) return false;
  const recorded = await recordBrowserVmUptime(
    workspaceId,
    row.poweredOnAt,
    endedBefore ? row.stateChangedAt : now
  );
  return recorded || !endsNow;
}

/**
 * Record a removed VM's last stretch before its record goes. False when it
 * could not be: the deletion keeps the record and the reconcile tries again,
 * until the deletion is overdue and goes ahead without it.
 */
async function closeRemovedUptime(vm: BrowserVm, now: Date) {
  let row: BrowserVm | undefined;
  try {
    row = await readBrowserVm(vm.workspaceId);
  } catch (error) {
    console.warn("[usage-costs] the VM's power-on could not be read", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: vm.workspaceId,
    });
    return false;
  }
  if (row?.poweredOnAt === null || row?.poweredOnAt === undefined) return true;
  return recordBrowserVmUptime(
    vm.workspaceId,
    row.poweredOnAt,
    uptimeEnded(row.state, row.vmId) ? row.stateChangedAt : now
  );
}

/**
 * The workspace's VM when its worker is up, or how long to wait before
 * asking again while it is being created or started. A VM that is off is
 * started, and one that does not exist is created: both take minutes, so
 * the errand waits in the queue meanwhile rather than holding a turn. A VM
 * that is up but whose worker did not answer this once is left as it is:
 * the errand waits, and only the reconcile takes a VM out of service.
 */
export async function ensureBrowserVm(workspaceId: string, now = new Date()) {
  const record = await ensureBrowserVmRecord(workspaceId);
  // A pool workspace's browser is a sandbox on a shared host instead: the
  // same record, lease and worker, placed elsewhere (docs/browser-pool.md).
  if (await inBrowserPool(record)) return ensureBrowserSandbox(record, now);
  if (record.state === "ready") return readyForErrand(record, now, false);
  const claimed = await claimBrowserVmLease(workspaceId, now, leaseMs);
  if (!claimed) return starting(leaseHeldRetryMs);
  let handedOver: BrowserVm;
  try {
    // The reconcile that held the lease may have brought it up meanwhile.
    if (claimed.state === "ready") {
      return await readyForErrand(claimed, now, true);
    }
    const step = await bringUpForErrand(claimed, now);
    if (step.kind === "starting") return step;
    handedOver = step.vm;
  } finally {
    await releaseBrowserVmLease(workspaceId, claimed.leaseUntil ?? undefined);
  }
  // A pool workspace's VM was gone: the same errand goes on to a sandbox.
  return ensureBrowserSandbox(handedOver, now);
}

/** An errand used the VM: its idle stop counts from now. */
export async function touchBrowserVm(workspaceId: string, now = new Date()) {
  return updateBrowserVm(workspaceId, { lastUsedAt: now }, now);
}

/**
 * Make sure the VM's Chrome goes out through the workspace's residential
 * proxy with an exit inside Russia before an errand starts: a Russian shop
 * judges the person by that address. The worker forgets the proxy when it
 * restarts, and a sticky exit may move, so both are checked; an exit
 * elsewhere is replaced by rotating the sticky session.
 *
 * A run going on the browser keeps its exit outright, whatever the worker's
 * health says: moving it mid-run would move the person mid-errand. A
 * follow-up of an errand (`rotate: false`) and a start that would otherwise
 * rotate (`rotate: true`, or a `freshExit` retry) while the workspace still
 * holds another errand's kept page behave the same way, since a rotation
 * would move that page's address too: the stored session is re-verified
 * instead of trusted — an exit never confirmed (`proxyExit` cleared by a
 * rotation that found none) is checked again even if the worker still
 * reports a proxy set, since that alone does not say the exit is Russian.
 * Only a proxy the worker lost is set again, on the same sticky session, and
 * whatever Russian exit it gives is kept, slow or not.
 *
 * A fresh start moves to the next rotation when its check is stale, and
 * `freshExit` (an anti-bot retry) moves to the next one outright, even when
 * the current exit is fresh and Russian: the site turning the errand away is
 * itself a reason to try another address.
 */
export async function prepareBrowserVmSession(
  vm: BrowserVm,
  now = new Date(),
  {
    freshExit = false,
    rotate = true,
  }: { readonly freshExit?: boolean; readonly rotate?: boolean } = {}
) {
  const health = await readBrowserVmWorkerHealth(vm);
  if (health.busy) {
    return health.proxy ? vm : routeThroughRussia(vm, now, rotationOf(vm), 0);
  }
  const movable =
    (rotate || freshExit) &&
    (await listWorkspacesHoldingBrowsers([vm.workspaceId], now)).length === 0;
  if (!movable) {
    return health.proxy && vm.proxyExit !== null
      ? vm
      : routeThroughRussia(vm, now, rotationOf(vm), 0);
  }
  if (freshExit) {
    return routeThroughRussia(vm, now, rotationOf(vm) + 1, exitRotations);
  }
  const checkedAt =
    vm.proxyExit === null ? Number.NaN : Date.parse(vm.proxyExit.at);
  if (health.proxy && checkedAt > now.getTime() - exitCheckMs) return vm;
  return routeThroughRussia(vm, now, rotationOf(vm), exitRotations);
}

/**
 * Look after every VM on its way up or down, stop the idle ones, and power
 * off the failed ones. The poller calls this each minute; each VM is claimed
 * on its own, and one that fails to settle is left for the next minute
 * without holding up the rest.
 */
export async function reconcileBrowserVms(now = new Date()) {
  const rows = await listBrowserVmsToReconcile(
    now,
    browserVmUnusedBefore(now),
    reconcileLimit
  );
  await Promise.all([
    ...rows.map(async (row) => {
      try {
        await (row.sandboxState === null
          ? reconcileBrowserVm(row.workspaceId, now)
          : reconcileBrowserSandbox(row.workspaceId, now));
      } catch (error) {
        console.warn("[browser-vm] the VM could not be reconciled", {
          cause: error,
          state: row.state,
          workspaceId: row.workspaceId,
        });
      }
    }),
    // The pool's hosts and the sandboxes a failed host left behind, while
    // the pool is configured or still has hosts: a host bills until it is
    // deleted, whichever of the pool's settings was taken away.
    reconcileBrowserPool(now),
  ]);
}

/**
 * Delete the workspace's VM with its boot disk, its public address and every
 * backup of the disk — the disk is the person's browser profile — and then
 * the record. True once all of it is gone; false while Cloud.ru is still
 * deleting the VM: the record stays `deleting` until Cloud.ru no longer
 * knows the VM, and the poller's reconcile finishes the job. The record is
 * the only trace of a VM that is still billed, so the workspace cannot be
 * deleted before it. Throws when another step held the VM too long or
 * Cloud.ru did not take the deletion, so the caller keeps the workspace.
 */
export async function deleteBrowserVm(workspaceId: string, now = new Date()) {
  const claimed = await claimForDeletion(workspaceId, now, 0);
  if (claimed === undefined) return true;
  try {
    // A pool workspace's sandbox goes from its host, its sets from Object
    // Storage, then the record.
    if (claimed.sandboxState !== null) {
      return await removeBrowserSandbox(claimed, now);
    }
    // Marked first, so an errand arriving meanwhile waits instead of
    // powering the VM on again.
    const deleting = await writeHeld(claimed, { state: "deleting" }, now);
    return await removeBrowserVm(deleting, now);
  } finally {
    await releaseBrowserVmLease(workspaceId, claimed.leaseUntil ?? undefined);
  }
}

function starting(retryAfterMs: number) {
  return { kind: "starting" as const, retryAfterMs };
}

function overdue(vm: BrowserVm, now: Date, afterMs: number) {
  return now.getTime() - vm.stateChangedAt.getTime() >= afterMs;
}

/**
 * The VM for an errand when its worker is alive, or a short wait. A missed
 * answer is not written down: one slow health check must not take a VM that
 * is up out of service, and a run may be going on it. A profile the person
 * asked to forget is wiped by the reconcile before any errand runs on it.
 * The touch reads the state back: an idle stop that began between the two
 * reads has the VM, and the errand waits for it instead.
 */
async function readyForErrand(vm: BrowserVm, now: Date, held: boolean) {
  const health = vm.profileResetPending ? undefined : await aliveWorker(vm);
  if (health === undefined) return starting(transitionRetryMs);
  // The address is Cloud.ru's to hand on. A VM deleted outside Bro leaves
  // the record pointing at an address that may be another machine's by now,
  // whose worker answers the unsigned health check like ours does: the
  // errand would send it the proxy login, the model key and the site's
  // secrets before its worker refused the signature. So the errand goes out
  // only while Cloud.ru still has this VM, running, on this address; a
  // record that says otherwise is set right under the lease (`bringUp`
  // forgets a VM that is gone, and the next errand creates one).
  let cloud: CloudVm | undefined;
  try {
    cloud = vm.vmId === null ? undefined : await readCloudRuVm(vm.vmId);
  } catch (error) {
    // Unconfirmed is not ours: the errand waits for Cloud.ru to answer.
    console.warn("[browser-vm] Cloud.ru could not confirm the VM", {
      cause: error,
      workspaceId: vm.workspaceId,
    });
    return starting(transitionRetryMs);
  }
  if (cloud?.state !== "running" || cloud.host !== vm.host) {
    await relocate(vm, now, held);
    return starting(transitionRetryMs);
  }
  // Only now, with the address confirmed ours, does a signed call go to it.
  // Another step rolling a worker out may be restarting it: wait for that.
  if (!held && browserVmWorkerRollingOut(vm, new Date())) {
    return starting(leaseHeldRetryMs);
  }
  if (
    browserVmWorkerDue(vm, health, now) !== undefined &&
    !(await updateWorkerForErrand(vm, now, held))
  ) {
    return starting(transitionRetryMs);
  }
  const touched = await touchBrowserVm(vm.workspaceId, now);
  return touched.state === "ready"
    ? { kind: "ready" as const, vm: touched }
    : starting(transitionRetryMs);
}

/**
 * Give the VM the published worker before the errand, under the lease: one
 * rollout at a time per VM. Whether the errand may go ahead now. It goes on
 * the old worker whenever the rollout does not go through (`rollout.ts`
 * never throws) or another step holds the VM for something else; it waits
 * only while another step is rolling a worker out, while the address or
 * the worker changed under the lease, or while a worker that was asked to
 * update does not answer alive yet (systemd brings the old code back).
 */
async function updateWorkerForErrand(vm: BrowserVm, now: Date, held: boolean) {
  // Checked before the lease: a VM that is in use needs none.
  if (!(await browserVmIdleForWorker(vm, now))) return true;
  const claimed = held
    ? vm
    : await claimBrowserVmLease(vm.workspaceId, new Date(), leaseMs);
  if (!claimed) {
    const current = await readBrowserVm(vm.workspaceId).catch(() => undefined);
    return (
      current === undefined || !browserVmWorkerRollingOut(current, new Date())
    );
  }
  try {
    // Taken out of service meanwhile: the touch sees that and waits.
    if (claimed.state !== "ready") return true;
    // Another address than the one Cloud.ru confirmed: the next ask checks it.
    if (claimed.host !== vm.host) return false;
    // Read again under the lease: another errand may have updated it, or
    // started a run on it, since.
    const health = await aliveWorker(claimed);
    if (health === undefined) return false;
    if (!(await rollOutBrowserVmWorker(claimed, health, new Date()))) {
      return true;
    }
    return (await aliveWorker(claimed)) !== undefined;
  } finally {
    if (!held) {
      await releaseBrowserVmLease(
        vm.workspaceId,
        claimed.leaseUntil ?? undefined
      );
    }
  }
}

/**
 * Take a ready VM that Cloud.ru no longer has as it was recorded back to
 * `starting` and follow it up there: gone, it is forgotten; moved to another
 * address, the record follows it; off, the watchdog brings it back.
 */
async function relocate(vm: BrowserVm, now: Date, held: boolean) {
  const claimed = held
    ? vm
    : await claimBrowserVmLease(vm.workspaceId, now, leaseMs);
  if (!claimed) return;
  try {
    if (claimed.state !== "ready") return;
    await bringUp(await writeHeld(claimed, { state: "starting" }, now), now);
  } finally {
    if (!held) {
      await releaseBrowserVmLease(
        vm.workspaceId,
        claimed.leaseUntil ?? undefined
      );
    }
  }
}

/**
 * The worker's health when it is alive: set up with Chrome answering, or
 * busy with a run, which is proof of life even while Chrome restarts under
 * it. Undefined when the worker did not answer or is not alive.
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

/**
 * The step an errand takes under the lease, and how long it should wait for
 * it. The state is written before Cloud.ru is asked, so a deletion marked
 * meanwhile is not overwritten after it. A pool workspace never gets a VM
 * created: one whose own VM is gone is handed over to the pool, and the
 * record comes back for the errand to go on with.
 */
async function bringUpForErrand(
  vm: BrowserVm,
  now: Date
): Promise<ReturnType<typeof starting> | { kind: "handed"; vm: BrowserVm }> {
  // Already on its way up or down, or being deleted.
  if (vm.state !== "failed" && vm.state !== "stopped") {
    return starting(transitionRetryMs);
  }
  if (await usesBrowserPool({ workspaceId: vm.workspaceId })) {
    return handOverForErrand(vm, now);
  }
  return starting(
    await (vm.vmId === null ? createVm(vm, now) : restartVm(vm, vm.vmId, now))
  );
}

/**
 * Create the workspace's VM. The create is never sent twice: an answer lost
 * on the way may still mean a VM, so the record stays `creating` without an
 * id, and the reconcile looks the VM up by its name. A create that never
 * left — Cloud.ru's key, token or project could not be had — made nothing,
 * and the next errand tries again.
 */
async function createVm(vm: BrowserVm, now: Date) {
  const { workspaceId } = vm;
  const generation = vm.generation + 1;
  const name = `bro-${nameStem(workspaceId)}-${String(generation)}`;
  const cloudInit = browserVmCloudInit({ workspaceId });
  await writeHeld(
    vm,
    {
      bootDiskId: null,
      floatingIpId: null,
      generation,
      givenUpAt: null,
      host: null,
      lastError: null,
      lastUsedAt: null,
      // A new VM starts with an empty profile: there is nothing to wipe.
      profileResetPending: false,
      proxyExit: null,
      recoveries: 0,
      state: "creating",
      vmId: null,
      vmName: name,
      // A new disk has the image's worker: a version that failed on the old
      // one is tried afresh.
      workerFailedVersion: null,
      workerRolloutAt: null,
    },
    now
  );
  let created: Awaited<ReturnType<typeof createCloudRuVm>>;
  try {
    created = await createCloudRuVm({ cloudInit, name });
  } catch (error) {
    if (error instanceof CloudRuUnsentError) {
      await writeHeld(vm, { lastError: error.message, state: "failed" }, now);
      await alert(
        "cloudru-access",
        [
          `Бро не смог обратиться к Cloud.ru, чтобы создать браузерную VM: ${error.message.slice(0, 300)}`,
          "Поручения ждут в очереди. Проверь CLOUDRU_KEY_ID, CLOUDRU_KEY_SECRET, CLOUDRU_PROJECT_ID и CLOUDRU_BROWSER_IMAGE.",
        ].join("\n")
      );
      throw new BrowserUseError(
        429,
        "browser-vm",
        "Cloud.ru could not be asked for a VM.",
        unsentRetryMs
      );
    }
    if (
      !(
        error instanceof CloudRuError &&
        error.status >= 400 &&
        error.status < 500
      )
    ) {
      await writeHeld(
        vm,
        {
          lastError: `The create of ${name} got no answer; the VM may exist.`,
        },
        now
      );
      throw error;
    }
    // Refused outright: nothing was created.
    await writeHeld(vm, { lastError: error.message, state: "failed" }, now);
    if (quotaExhausted(error)) {
      await alert(
        "cloudru-quota",
        [
          `Cloud.ru не дал создать браузерную VM (${String(error.status)}): похоже, кончилась квота проекта.`,
          "Поручения ждут в очереди. Расширь квоту или удали лишние VM в консоли Cloud.ru.",
        ].join("\n")
      );
      throw new BrowserUseError(
        429,
        "browser-vm",
        "Cloud.ru has no capacity for another VM.",
        quotaRetryMs
      );
    }
    await alert(
      "browser-vm-create",
      [
        `Cloud.ru отказал в создании браузерной VM (${String(error.status)}): ${error.body.slice(0, 300)}`,
        "Проверь CLOUDRU_BROWSER_IMAGE, флейвор, подсеть и группу безопасности.",
      ].join("\n")
    );
    throw error;
  }
  await writeHeld(vm, { image: created.image, vmId: created.id }, now);
  return createRetryMs;
}

/**
 * Start a VM that exists for an errand. One gone from Cloud.ru — deleted
 * by hand, say — is created afresh.
 */
async function restartVm(vm: BrowserVm, vmId: string, now: Date) {
  const cloud = await readCloudRuVm(vmId);
  if (cloud === undefined) return createVm(await forgetGoneVm(vm, now), now);
  return startVm(vm, cloud, now);
}

/**
 * Power a VM on when it is off, reboot it when it failed while running, or
 * wait while it changes state at Cloud.ru; the reconcile follows it up.
 */
async function startVm(vm: BrowserVm, cloud: CloudVm, now: Date) {
  await writeHeld(
    vm,
    { lastError: null, recoveries: 0, state: "starting" },
    now
  );
  if (cloud.state === "stopped") {
    await setCloudRuVmPower(cloud.id, "power_on");
    return powerOnRetryMs;
  }
  if (vm.state === "failed" && cloud.state === "running") {
    await setCloudRuVmPower(cloud.id, "reboot");
    return powerOnRetryMs;
  }
  return transitionRetryMs;
}

async function reconcileBrowserVm(workspaceId: string, now: Date) {
  const claimed = await claimBrowserVmLease(workspaceId, now, leaseMs);
  if (!claimed) return;
  try {
    switch (claimed.state) {
      case "creating":
      case "starting": {
        await bringUp(claimed, now);
        break;
      }
      case "ready": {
        await tendReadyVm(claimed, now);
        break;
      }
      case "stopping": {
        await settleStop(claimed, now);
        break;
      }
      case "deleting": {
        await settleDeletion(claimed, now);
        break;
      }
      case "failed": {
        await settleFailure(claimed, now);
        break;
      }
      case "stopped": {
        await wipeStoppedVm(claimed, now);
        break;
      }
    }
  } finally {
    await releaseBrowserVmLease(workspaceId, claimed.leaseUntil ?? undefined);
  }
}

/**
 * Follow a VM that is being created or started until its worker answers
 * alive. Its address comes a little after the VM itself, and a VM whose
 * create lost its answer is found by its name. A VM that does not come up
 * is rebooted once and then handed to the owner, powered off; it is never
 * deleted here, since its disk may hold the person's profile.
 */
async function bringUp(vm: BrowserVm, now: Date) {
  const { workspaceId } = vm;
  const cloud = await cloudVmOf(vm);
  if (vm.vmId !== null && cloud === undefined) {
    await forgetGone(vm, now, { lastError: "The VM is gone from Cloud.ru." });
    return;
  }
  const found = {
    bootDiskId: cloud?.bootDiskId ?? vm.bootDiskId,
    floatingIpId: cloud?.floatingIpId ?? vm.floatingIpId,
    host: cloud?.host ?? vm.host,
    vmId: cloud?.id ?? vm.vmId,
  };
  const located =
    found.host === vm.host &&
    found.floatingIpId === vm.floatingIpId &&
    found.bootDiskId === vm.bootDiskId &&
    found.vmId === vm.vmId
      ? vm
      : await writeHeld(vm, found, now);
  const health =
    cloud?.state === "running" ? await aliveWorker(located) : undefined;
  if (health !== undefined) {
    await markReady(located, health.busy, now);
    return;
  }
  if (!overdue(vm, now, rebootAfterMs)) return;
  if (cloud?.state === "running" && (await runMayBeGoing(workspaceId, now))) {
    return;
  }
  if (overdue(vm, now, failAfterMs)) {
    await giveUp(located, now, cloud);
    return;
  }
  if (vm.recoveries > 0 || cloud === undefined) return;
  const power =
    cloud.state === "running"
      ? "reboot"
      : cloud.state === "stopped"
        ? "power_on"
        : undefined;
  // Still being created or changing state at Cloud.ru: nothing to kick.
  if (power === undefined) return;
  // Counted before it is sent: a reboot that landed but lost its answer is
  // not sent again.
  await writeHeld(vm, { recoveries: vm.recoveries + 1 }, now);
  await setCloudRuVmPower(cloud.id, power);
}

/**
 * A VM whose worker answered is ready, and no longer given up on. A profile
 * forgotten while it was off is wiped first, so nothing runs on it; a
 * worker busy with a run cannot wipe it yet, so the flag stays, errands
 * wait, and the reconcile wipes it once the run is over. The idle stop
 * counts from here, so an errand that was told to wait finds the VM still
 * up when it comes back.
 */
async function markReady(vm: BrowserVm, busy: boolean, now: Date) {
  if (vm.profileResetPending && !busy) await wipeProfile(vm, now);
  await writeHeld(
    vm,
    {
      givenUpAt: null,
      healthFailures: 0,
      lastError: null,
      lastUsedAt: now,
      state: "ready",
    },
    now
  );
}

/**
 * Wipe the Chrome profile on a VM that is up, and clear the flag of the
 * forget this answered. A forget that came in meanwhile moved the profile
 * generation on and keeps its flag, so its wipe is not lost.
 */
async function wipeProfile(vm: BrowserVm, now: Date) {
  await resetBrowserVmWorkerProfile(vm);
  await clearBrowserVmProfileReset(vm.workspaceId, vm.profileGeneration, now);
}

/**
 * Check on a ready VM whose idle window may be over or that has a profile
 * to wipe, and stop it when idle. A worker that misses a health check keeps
 * its VM; after a few in a row the VM goes back to `starting`, where the
 * watchdog reboots it and then hands it to the owner.
 */
async function tendReadyVm(vm: BrowserVm, now: Date) {
  const health = await aliveWorker(vm);
  if (health === undefined) {
    const missed = vm.healthFailures + 1;
    await writeHeld(
      vm,
      missed < missedChecksToDemote
        ? { healthFailures: missed }
        : {
            healthFailures: 0,
            lastError: `The worker missed ${String(missed)} health checks in a row.`,
            recoveries: 0,
            state: "starting",
          },
      now
    );
    return;
  }
  if (vm.healthFailures > 0) {
    await writeHeld(vm, { healthFailures: 0 }, now);
  }
  // A run holds the browser: the VM is neither idle nor free to be wiped.
  if (health.busy) return;
  if (vm.profileResetPending) await wipeProfile(vm, now);
  await stopIfIdle(vm, now);
}

/**
 * Stop a VM whose idle window is over (`idle.ts`: the person's, or the short
 * one of an errand nobody waits for or a code wait): no run of it is open, no
 * errand's page is kept in its browser, and no errand is queued for it,
 * parked for a retry, or owed its report. Chrome is stopped first so it
 * writes its cookies to the profile, and the state is written before the
 * power goes off: an errand that touched the VM or moved its window in
 * between is seen and keeps it up.
 */
async function stopIfIdle(vm: BrowserVm, now: Date) {
  const { vmId, workspaceId } = vm;
  if (vmId === null) return;
  if (!browserVmIdleStopDue(vm, now)) return;
  if (await hasOpenRunSince(workspaceId, now.getTime() - openRunWindowMs)) {
    return;
  }
  const holding = await listWorkspacesHoldingBrowsers([workspaceId], now);
  if (holding.length > 0) return;
  if (await workspaceHasPendingBrowserErrand(workspaceId, now)) return;
  const stopping = await writeHeld(vm, { state: "stopping" }, now);
  if (!browserVmIdleStopDue(stopping, now)) {
    await writeHeld(vm, { state: "ready" }, now);
    return;
  }
  try {
    await controlBrowserVmWorkerChrome(vm, "stop");
  } catch (error) {
    // Powered off anyway: an idle VM must not bill on for a stuck Chrome.
    console.warn("[browser-vm] Chrome could not be stopped cleanly", {
      cause: error,
      workspaceId,
    });
  }
  await setCloudRuVmPower(vmId, "power_off");
}

/**
 * A VM powering off is `stopped` once Cloud.ru says so. A power-off that did
 * not take is sent again, and one that still has not taken goes to the
 * owner.
 */
async function settleStop(vm: BrowserVm, now: Date) {
  const cloud = vm.vmId === null ? undefined : await readCloudRuVm(vm.vmId);
  if (cloud === undefined) {
    await forgetGone(vm, now, { lastError: null });
    return;
  }
  if (cloud.state === "stopped") {
    await writeHeld(vm, { state: "stopped" }, now);
    return;
  }
  if (overdue(vm, now, settleFailAfterMs)) {
    await giveUp(vm, now);
    return;
  }
  if (cloud.state === "running" && overdue(vm, now, rebootAfterMs)) {
    await setCloudRuVmPower(cloud.id, "power_off");
  }
}

/**
 * Carry a deletion on until Cloud.ru no longer knows the VM. One that has
 * not got there in a while goes to the owner: the record then stays, as the
 * trace of what may still be billed.
 */
async function settleDeletion(vm: BrowserVm, now: Date) {
  let removed = false;
  try {
    removed = await removeBrowserVm(vm, now);
  } catch (error) {
    if (!overdue(vm, now, settleFailAfterMs)) throw error;
    console.warn("[browser-vm] the VM could not be deleted", {
      cause: error,
      workspaceId: vm.workspaceId,
    });
  }
  if (!removed && overdue(vm, now, settleFailAfterMs)) await giveUp(vm, now);
}

/**
 * A VM given up on is powered off, keeping its disk and the profile on it.
 * Once Cloud.ru says it is off it is simply stopped, and the next errand
 * powers it on; the failure stays in `last_error`.
 */
async function settleFailure(vm: BrowserVm, now: Date) {
  if (vm.vmId === null) return;
  const cloud = await readCloudRuVm(vm.vmId);
  if (cloud === undefined) {
    await forgetGone(vm, now);
    return;
  }
  if (cloud.state === "stopped") {
    await writeHeld(vm, { state: "stopped" }, now);
    return;
  }
  if (cloud.state === "running") {
    await setCloudRuVmPower(cloud.id, "power_off");
  }
}

/**
 * The person asked to forget the sign-ins while the VM was off: it is
 * powered on to wipe them rather than keeping them on its disk until some
 * next errand, and it idles off again afterwards. A VM that was given up on
 * is left for the next errand, which wipes the profile before it runs: it
 * would most likely fail again, and be started again, every twenty minutes.
 * A VM gone from Cloud.ru took the profile with its disk.
 */
async function wipeStoppedVm(vm: BrowserVm, now: Date) {
  if (!vm.profileResetPending || vm.vmId === null || vm.givenUpAt !== null) {
    return;
  }
  const cloud = await readCloudRuVm(vm.vmId);
  if (cloud === undefined) {
    await forgetGone(vm, now);
    return;
  }
  await startVm(vm, cloud, now);
}

/**
 * Mark the VM failed, tell the owner, and power it off when it still runs,
 * so a VM nobody can use does not bill on; its disk and the profile on it
 * stay. A power-off that fails here is sent again by the reconcile of the
 * failed VM. One that did not come up is marked given up on, so only an
 * errand starts it again.
 *
 * A VM that never came up from its create holds no profile: it is let go
 * outright rather than kept powered off (`giveUpAbandoned`), so the next
 * errand creates a new one under the next generation's name rather than
 * waiting on a VM Cloud.ru may keep stuck in `creating`.
 *
 * A deletion that would not settle stays `deleting`, never demoted to plain
 * `failed`: `failed` is one of the two states (with `stopped`) an ordinary
 * errand's `bringUpForErrand` is free to restart, and doing so here would
 * silently undo the deletion the caller — and the workspace's `restrict` FK,
 * kept specifically so a workspace cannot be removed before its VM is — rely
 * on being final. Left `deleting`, the reconcile keeps retrying the delete
 * every minute (`settleDeletion`, safe to repeat) until it lands or an
 * explicit `deleteBrowserVm` retry, or the owner's own Cloud.ru cleanup,
 * finishes it.
 */
async function giveUp(vm: BrowserVm, now: Date, cloud?: CloudVm) {
  const failure = failureOf(vm);
  if (vm.state === "creating") {
    await giveUpAbandoned(vm, now, failure, cloud);
    return;
  }
  await writeHeld(
    vm,
    {
      givenUpAt: vm.state === "starting" ? now : vm.givenUpAt,
      lastError: failure.lastError,
      state: vm.state === "deleting" ? "deleting" : "failed",
    },
    now
  );
  await alertGiveUp(vm, failure);
  if (vm.vmId === null) return;
  try {
    const found = cloud ?? (await readCloudRuVm(vm.vmId));
    if (found?.state === "running") {
      await setCloudRuVmPower(found.id, "power_off");
    }
  } catch (error) {
    console.warn("[browser-vm] the failed VM could not be powered off", {
      cause: error,
      workspaceId: vm.workspaceId,
    });
  }
}

/**
 * Give up on a VM whose create never confirmed it healthy: deleted outright,
 * since it holds no profile yet. The delete is tried before the record
 * forgets the VM's ids, so a delete that fails (a 5xx or the network) leaves
 * them in place — the record stays exactly as it was — for the next
 * reconcile to try the give-up again, rather than losing track of a VM that
 * keeps billing nobody retries. Cloud.ru refusing outright (422, a VM stuck
 * in a state it will not delete from) is treated as done: nothing further
 * would make it try again, so the ids are let go and the owner is told to
 * remove it by hand.
 *
 * `cloud` is the caller's own read of the VM, when it already made one (as
 * `bringUp` does, moments before): reused here instead of read again, so the
 * fresh-address settle below (`settledFloatingIpId`) starts from a real wait
 * rather than being handed the address's own "not yet" a second time for
 * free — a re-read here answers no differently a moment later, and only
 * spends one of the settle's own attempts without ever letting it wait.
 */
async function giveUpAbandoned(
  vm: BrowserVm,
  now: Date,
  failure: ReturnType<typeof failureOf>,
  cloud?: CloudVm
) {
  if (vm.vmId !== null) {
    try {
      const found = cloud ?? (await readCloudRuVm(vm.vmId));
      if (found !== undefined) {
        const floatingIpId =
          found.floatingIpId ??
          vm.floatingIpId ??
          (await settledFloatingIpId(found.id));
        await deleteCloudRuVm(found.id, {
          diskIds: present([found.bootDiskId ?? vm.bootDiskId]),
          floatingIpIds: present([floatingIpId]),
        });
      }
    } catch (error) {
      if (!(error instanceof CloudRuError && error.status === 422)) throw error;
    }
  }
  await writeHeld(
    vm,
    {
      bootDiskId: null,
      floatingIpId: null,
      host: null,
      lastError: failure.lastError,
      state: "failed",
      vmId: null,
    },
    now
  );
  await alertGiveUp(vm, failure);
}

async function alertGiveUp(
  vm: BrowserVm,
  failure: ReturnType<typeof failureOf>
) {
  await alert(
    `${failure.alertKey}:${vm.workspaceId}`,
    [
      `Браузерная VM ${vm.vmName ?? vm.vmId ?? "?"}${vm.vmId === null ? "" : ` (${vm.vmId})`} (воркспейс ${vm.workspaceId}) ${failure.summary}: ${failure.lastError}`,
      failure.advice,
    ].join("\n")
  );
}

function failureOf(vm: BrowserVm) {
  const settleMinutes = String(Math.round(settleFailAfterMs / 60_000));
  switch (vm.state) {
    case "creating": {
      const minutes = String(Math.round(failAfterMs / 60_000));
      return {
        advice:
          "Профиля на ней ещё нет: Бро пробует её удалить и при следующем поручении создаст новую. Если VM осталась в консоли Cloud.ru (зависшую в creating API не удаляет), удали её там или через поддержку: она держит квоту.",
        alertKey: "browser-vm-create-failed",
        lastError:
          vm.vmId === null
            ? `The VM ${vm.vmName ?? "?"} was never confirmed created.`
            : `The new VM did not answer healthy within ${minutes} minutes.`,
        summary: `не поднялась после создания за ${minutes} минут`,
      };
    }
    case "stopping": {
      return {
        advice:
          "Бро выключает её снова; если она так и работает, выключи её в консоли Cloud.ru.",
        alertKey: "browser-vm-stop-failed",
        lastError: `The VM did not power off within ${settleMinutes} minutes.`,
        summary: `не выключилась за ${settleMinutes} минут`,
      };
    }
    case "deleting": {
      return {
        advice:
          "Удали её в консоли Cloud.ru вместе с диском, публичным адресом и бэкапами диска, затем повтори удаление.",
        alertKey: "browser-vm-delete-failed",
        lastError: `The VM was not deleted within ${settleMinutes} minutes.`,
        summary: `не удалилась за ${settleMinutes} минут`,
      };
    }
    default: {
      const minutes = String(Math.round(failAfterMs / 60_000));
      return {
        advice: vm.profileResetPending
          ? "Бро выключает её и сам больше не включает. Человек попросил забыть входы на сайты, а стереть их на выключенной VM нельзя: следующее поручение попробует запустить её снова и сотрёт профиль до начала. Входы забыты всё равно, так что сломанную VM можно просто удалить в консоли Cloud.ru: Бро создаст новую."
          : "Бро выключает её, диск с профилем цел. Следующее поручение попробует запустить её снова. Если VM сломана, удали её в консоли Cloud.ru: тогда Бро создаст новую, но входы на сайты пропадут.",
        alertKey: "browser-vm-failed",
        lastError: `The VM did not answer healthy within ${minutes} minutes.`,
        summary: `не поднялась за ${minutes} минут`,
      };
    }
  }
}

/** Whether the workspace has a run still open that started after `since`. */
async function hasOpenRunSince(workspaceId: string, since: number) {
  const openRuns = await listOpenBrowserVmRuns(workspaceId);
  return openRuns.some((run) => run.createdAt.getTime() > since);
}

async function runMayBeGoing(workspaceId: string, now: Date) {
  return hasOpenRunSince(workspaceId, now.getTime() - liveRunWindowMs);
}

/**
 * The VM at Cloud.ru, or undefined when there is none: by its id, or by its
 * name when a create lost its answer before the id was known.
 */
async function cloudVmOf(vm: BrowserVm) {
  if (vm.vmId !== null) return readCloudRuVm(vm.vmId);
  return vm.vmName === null ? undefined : findCloudRuVmByName(vm.vmName);
}

/**
 * The floating IP a VM's interfaces have not shown yet, given a little time
 * to attach: a handful of short rereads, since a delete or a give-up that
 * takes the address as missing on a single early read lets it go unnamed —
 * `deleteCloudRuVm` only releases what `delete_attachments.external_ips`
 * names — and it is never found again. Undefined once the VM itself is gone
 * (nothing further would show an address for it) or the attempts run out.
 */
async function settledFloatingIpId(
  vmId: string,
  attemptsLeft = floatingIpSettleAttempts
): Promise<string | undefined> {
  if (attemptsLeft <= 0) return undefined;
  await sleep(floatingIpSettlePollMs);
  const cloud = await readCloudRuVm(vmId);
  if (cloud === undefined) return undefined;
  return cloud.floatingIpId ?? settledFloatingIpId(vmId, attemptsLeft - 1);
}

/**
 * The lease for a deletion: it waits a little for another step on the VM
 * rather than racing it, since a create or a power-on landing after the
 * deletion would leave a billed VM nobody knows of. Undefined when there is
 * no record (left) to delete.
 */
async function claimForDeletion(
  workspaceId: string,
  now: Date,
  waitedMs: number
): Promise<BrowserVm | undefined> {
  const claimed = await claimBrowserVmLease(
    workspaceId,
    new Date(now.getTime() + waitedMs),
    leaseMs
  );
  if (claimed) return claimed;
  if ((await readBrowserVm(workspaceId)) === undefined) return undefined;
  if (waitedMs >= deletionLeaseWaitMs) {
    throw new Error(
      "The browser VM is busy with another step; its deletion did not start."
    );
  }
  await sleep(deletionLeasePollMs);
  return claimForDeletion(workspaceId, now, waitedMs + deletionLeasePollMs);
}

/**
 * One step of deleting the VM and what it leaves billed or holding the
 * person's data. While Cloud.ru knows the VM, the deletion is sent (once
 * the disk and the address it names are recorded) and false comes back;
 * once it is gone, the address, the backups of its disk and the record go,
 * and true comes back. Every call is safe to repeat: a VM, an address or a
 * backup already gone counts as deleted.
 */
async function removeBrowserVm(vm: BrowserVm, now: Date) {
  const cloud = await cloudVmOf(vm);
  if (cloud !== undefined) {
    const floatingIpId =
      cloud.floatingIpId ??
      vm.floatingIpId ??
      (await settledFloatingIpId(cloud.id));
    const known = await writeHeld(
      vm,
      {
        bootDiskId: cloud.bootDiskId ?? vm.bootDiskId,
        floatingIpId: floatingIpId ?? null,
        vmId: cloud.id,
      },
      now
    );
    // Cloud.ru is deleting it already: asking again changes nothing.
    if (cloud.state !== "deleting") {
      await deleteCloudRuVm(cloud.id, {
        diskIds: present([known.bootDiskId]),
        floatingIpIds: present([known.floatingIpId]),
      });
    }
    return false;
  }
  // An address kept apart from its VM is still billed.
  await Promise.all(
    present([vm.floatingIpId]).map(async (id) => deleteCloudRuFloatingIp(id))
  );
  await deleteCloudRuBackupsOf(present([vm.bootDiskId]));
  if (
    !(await closeRemovedUptime(vm, now)) &&
    !overdue(vm, now, settleFailAfterMs)
  ) {
    return false;
  }
  await deleteBrowserVmRecord(vm.workspaceId);
  return true;
}

function present(ids: readonly (string | null | undefined)[]) {
  return [...new Set(ids.filter((id) => id !== null && id !== undefined))];
}

/**
 * Point the worker at the proxy with this rotation of the workspace's sticky
 * session, and keep it when the exit is in Russia and not slow. An exit is
 * judged by its address alone: one whose speed could not be measured is not
 * slow, and a probe that failed next to a known address does not lose it.
 * Recursion rather than a loop keeps each attempt one awaited step.
 */
async function routeThroughRussia(
  vm: BrowserVm,
  now: Date,
  rotation: number,
  rotationsLeft: number
): Promise<BrowserVm> {
  const session = browserVmProxySession(vm.workspaceId, rotation);
  const checkStarted = Date.now();
  const rotated = rotation !== rotationOf(vm);
  let exit: Awaited<ReturnType<typeof setBrowserVmWorkerProxy>>["exit"];
  try {
    ({ exit } = await setBrowserVmWorkerProxy(vm, browserVmProxy(session)));
  } catch (error) {
    // The worker did not answer the check: how long the errand waited for
    // that, and the error's name only, since the request carried the login.
    console.warn("[browser-vm] the proxy exit checked", {
      durationMs: Date.now() - checkStarted,
      error: error instanceof Error ? error.name : null,
      kept: false,
      rotated,
      rotation,
      workspaceId: vm.workspaceId,
    });
    throw error;
  }
  // An exit address means the proxy took the login: its next refusal is a
  // new incident, and the owner hears of it at once.
  if (exit.ip) await proxyAccepted(now);
  const slow =
    (exit.mbps ?? Number.POSITIVE_INFINITY) < slowExitMbps ||
    (exit.latencyMs ?? 0) > slowExitLatencyMs;
  // A slow Russian exit is still taken when no rotation is left to try.
  const taken =
    exit.country === "RU" && exit.ip && (!slow || rotationsLeft === 0)
      ? { country: exit.country, ip: exit.ip }
      : undefined;
  // One line per check, before the errand starts: the worker asks ipinfo.io
  // (up to 20 s) and pulls a megabyte (up to 25 s) through the exit, and up
  // to four rotations may be tried. Never the proxy login or the address.
  const check = {
    country: exit.country ?? null,
    durationMs: Date.now() - checkStarted,
    error: exit.error ?? null,
    kept: taken !== undefined,
    latencyMs: exit.latencyMs ?? null,
    mbps: exit.mbps ?? null,
    rotated,
    rotation,
    speedError: exit.speedError ?? null,
    workspaceId: vm.workspaceId,
  };
  if (taken !== undefined) {
    console.info("[browser-vm] the proxy exit checked", check);
    return updateBrowserVm(
      vm.workspaceId,
      {
        proxyExit: {
          at: now.toISOString(),
          city: exit.city ?? null,
          country: taken.country,
          ip: taken.ip,
          org: exit.org ?? null,
        },
        proxySession: session,
      },
      now
    );
  }
  console.warn("[browser-vm] the proxy exit checked", check);
  // The proxy turned the login away: every sticky session of that login
  // meets the same answer, so only the owner's account can change it.
  const refusal = proxyRefusal(exit.error);
  if (refusal !== undefined) {
    await alert(
      proxyAlertKey,
      [
        `Резидентный прокси (BROWSER_VM_PROXY) отказывает Бро: ${refusal}.`,
        "Поручения в браузере ждут в очереди. Проверь баланс, тариф и пароль аккаунта прокси; если выдан новый логин — обнови BROWSER_VM_PROXY (порт sticky-сессий).",
      ].join("\n")
    );
    await updateBrowserVm(
      vm.workspaceId,
      { proxyExit: null, proxySession: session },
      now
    );
    throw new BrowserUseError(429, "proxy", "proxy refused", noExitRetryMs);
  }
  if (rotationsLeft > 0) {
    return routeThroughRussia(vm, now, rotation + 1, rotationsLeft - 1);
  }
  // The next errand goes on from this rotation rather than retrying the ones
  // that just failed, and checks the exit again before anything runs.
  await updateBrowserVm(
    vm.workspaceId,
    { proxyExit: null, proxySession: session },
    now
  );
  throw new BrowserUseError(429, "proxy", "no Russian exit", noExitRetryMs);
}

/**
 * The proxy's own refusal of the login, as the worker reports its CONNECT
 * (`ClientHttpProxyError: 407, message=…`): payment, a forbidden use or a
 * wrong password. A 502 is the worker's forwarder not reaching the proxy, and
 * a dead exit is a timeout: another rotation can fix those.
 */
function proxyRefusal(error: string | null | undefined) {
  // The whole message, however it is quoted, up to the worker's own address.
  return /^ClientHttpProxyError: (?:402|403|407)\b.*?(?=, url=|$)/su.exec(
    error ?? ""
  )?.[0];
}

/** Never throws: an errand must not fail because an alert was not re-armed. */
async function proxyAccepted(now: Date) {
  try {
    await clearOwnerAlert(proxyAlertKey, now);
  } catch (error) {
    console.warn("[browser-vm] the proxy alert could not be re-armed", {
      cause: error,
    });
  }
}

/** The rotation the workspace's stored sticky session is on. */
function rotationOf(vm: BrowserVm) {
  const rotation = /^bro[\da-f]{12}r(?<rotation>\d+)$/u.exec(
    vm.proxySession ?? ""
  )?.groups?.rotation;
  return rotation === undefined ? 0 : Number(rotation);
}

/**
 * A VM name Cloud.ru takes: lower-case letters, digits and hyphens. The
 * workspace's own id holds a colon (`personal:<hash>`).
 */
function nameStem(workspaceId: string) {
  return workspaceId
    .toLowerCase()
    .replaceAll(/[^\da-z-]/gu, "")
    .slice(0, 20);
}

/**
 * Whether a refused create was the project's quota rather than a bad
 * request. Cloud.ru's quota answer is not documented, so its status and its
 * words are both taken.
 */
function quotaExhausted(error: CloudRuError) {
  return (
    error.status === 403 ||
    error.status === 429 ||
    /quota|limit|exceed|квот|лимит|превыш/iu.test(error.body)
  );
}

/** Never throws: an errand must not fail because the owner was not told. */
async function alert(key: string, text: string) {
  try {
    await alertOwner(key, text, { repeatAfterMs: ownerAlertRepeatMs });
  } catch (error) {
    console.warn("[browser-vm] the owner could not be alerted", {
      cause: error,
      key,
    });
  }
}
