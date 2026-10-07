import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  BrowserStateStoreError,
  readBrowserStateObjectBytes,
} from "@agent/lib/browser-pool/s3";
import { objectStorageConfigured } from "@shared/object-storage/s3";
import { alertOwner } from "@agent/lib/owner-alert";
import type { browserVms } from "@db/schema/browser-vms";
import { listWorkspacesHoldingBrowsers } from "@db/services/browser-runs";
import {
  listOpenBrowserVmRuns,
  updateBrowserVm,
} from "@db/services/browser-vms";
import { env } from "@shared/environment";
import {
  BrowserVmWorkerError,
  readBrowserVmWorkerHealth,
  updateBrowserVmWorkerCode,
} from "./worker";

/**
 * Rolling a published worker (BROWSER_VM_WORKER) out to a workspace's own
 * VM before an errand. A VM made from an older image keeps its worker for
 * life otherwise: its disk is the person's profile, so it is never
 * re-created for a code change, and a new image cannot always be built. The
 * worker takes the new code itself (`POST /v1/admin/worker`): it checks the
 * checksum, runs the file's top-level code in a separate Python (where a
 * worker.py with `CANDIDATE_IMPORTS` imports browser-use, OpenCV and numpy,
 * which it otherwise imports only inside functions), and systemd rolls back
 * code that does not come up. A version that answers has started; whether
 * its runs work shows in the errands.
 *
 * The errand never waits long for it and never fails because of it: the
 * whole rollout is bounded well inside the lease, a rollout that does not
 * go through leaves the errand on the old worker, and a version that failed
 * on a VM for its own fault is not tried on that VM again
 * (`worker_failed_version`). One that failed for a passing cause is tried
 * again after `retryAfterMs`, not in every errand's path. Only a newer
 * version is rolled out, never an older one over a newer worker. Sandboxes
 * of the files pilot also update the worker that came with their root.
 */

type BrowserVm = typeof browserVms.$inferSelect;
type WorkerHealth = Awaited<ReturnType<typeof readBrowserVmWorkerHealth>>;

/**
 * The whole rollout from the download to the new version answering: well
 * inside the two-minute lease of lifecycle.ts, with room for the alert.
 */
const rolloutBudgetMs = 75_000;
/** The file is some 100 KB: a download slower than this is a stuck one. */
const downloadTimeoutMs = 15_000;
/** The new worker is up within seconds; past this the errand goes on. */
const upPollMs = 2_000;
const upWaitMs = 30_000;
/**
 * After an attempt that did not go through for a passing cause (Object
 * Storage or the worker out of reach), the next one waits this long.
 */
const retryAfterMs = 15 * 60_000;
/**
 * A VM handed to an errand this recently may have that errand still
 * setting up its session (the proxy check takes tens of seconds) with no
 * run recorded yet: a restart would cut it off.
 */
const handedOutMs = 90_000;
/**
 * A run record still open after an hour is one nobody read to its end
 * (`openRunWindowMs` of lifecycle.ts): it does not hold a rollout back.
 */
const openRunWindowMs = 60 * 60_000;
/** Once per version and kind of failure: the owner fixes the publication. */
const alertRepeatMs = 30 * 24 * 60 * 60_000;
/** A version as worker.py writes it: the day it was made and a counter. */
const datedVersion = /^(?<day>\d{4}-\d{2}-\d{2})\.(?<count>\d+)$/u;

/**
 * The published worker when this VM's worker should get it before the
 * errand: an older version answers, the worker is idle and the VM was not
 * just handed to an errand, the VM is a workspace's own or a files-pilot
 * sandbox, the version has not failed on it, and no attempt is under way
 * or failed a moment ago. A freshly started sandbox is not handed out yet.
 * Asks nothing of anyone.
 */
export function browserVmWorkerDue(
  vm: BrowserVm,
  health: WorkerHealth,
  now: Date,
  beforeHandout = false
) {
  const published = env.BROWSER_VM_WORKER;
  if (published === undefined) return undefined;
  const pooled = vm.sandboxState !== null || vm.hostId !== null;
  if (pooled && !browserPoolWorkerRolloutEnabled(vm.workspaceId)) {
    return undefined;
  }
  // Without the bucket there is nothing to fetch: said once, in the docs.
  if (!objectStorageConfigured()) return undefined;
  if (health.busy || !newer(published.version, health.worker)) {
    return undefined;
  }
  if (vm.workerFailedVersion === published.version) return undefined;
  if (since(vm.workerRolloutAt, now) < retryAfterMs) return undefined;
  if (!(pooled && beforeHandout) && since(vm.lastUsedAt, now) < handedOutMs) {
    return undefined;
  }
  return published;
}

export function browserPoolWorkerRolloutEnabled(workspaceId: string) {
  const workspaces = env.BROWSER_VM_FILES_WORKSPACES ?? [];
  return workspaces.includes("*") || workspaces.includes(workspaceId);
}

/**
 * Whether another step is rolling a worker out to the VM right now: its
 * worker may be restarting, so an errand waits for it to finish.
 */
export function browserVmWorkerRollingOut(vm: BrowserVm, now: Date) {
  return (
    env.BROWSER_VM_WORKER !== undefined &&
    vm.leaseUntil !== null &&
    vm.leaseUntil > now &&
    since(vm.workerRolloutAt, now) < rolloutBudgetMs
  );
}

/**
 * Whether nothing holds the VM's browser: no open run, and no page an
 * errand keeps for its follow-up. The restart would cut the one and drop
 * what the other holds in memory. Needs no lease; false when unknown.
 */
export async function browserVmIdleForWorker(vm: BrowserVm, now: Date) {
  try {
    const [openRuns, holding] = await Promise.all([
      listOpenBrowserVmRuns(vm.workspaceId),
      listWorkspacesHoldingBrowsers([vm.workspaceId], now),
    ]);
    const after = now.getTime() - openRunWindowMs;
    return (
      !openRuns.some((run) => run.createdAt.getTime() > after) &&
      holding.length === 0
    );
  } catch (error) {
    warn("the VM's runs could not be read", error, vm, undefined);
    return false;
  }
}

/**
 * Roll the published worker out to the VM, as the holder of the lease `vm`
 * was claimed under (with the health read under it), so one rollout at a
 * time goes to a VM. Never throws. True once the worker was asked to
 * replace its code (it may be restarting or rolled back since); false when
 * nothing was sent to it.
 */
export async function rollOutBrowserVmWorker(
  vm: BrowserVm,
  health: WorkerHealth,
  now: Date,
  beforeHandout = false
) {
  const published = browserVmWorkerDue(vm, health, now, beforeHandout);
  if (published === undefined) return false;
  const { version } = published;
  const deadline = Date.now() + rolloutBudgetMs;
  // Written first: an errand that finds the lease taken waits for this
  // rollout, and one that fails for a passing cause is not retried at once.
  try {
    await updateBrowserVm(
      vm.workspaceId,
      { workerRolloutAt: now },
      now,
      vm.leaseUntil ?? undefined
    );
  } catch (error) {
    warn("the rollout could not be written down", error, vm, version);
    return false;
  }

  let code: Uint8Array<ArrayBuffer>;
  try {
    code = await readBrowserStateObjectBytes(published.key, downloadTimeoutMs);
  } catch (error) {
    // No such object: the publication is broken. A refusal of the key, a
    // throttle or no answer may pass: tried again after `retryAfterMs`.
    const missing =
      error instanceof BrowserStateStoreError &&
      (error.status === 404 || error.status === 410);
    await fail(vm, version, "файл не скачался из Object Storage", error, {
      remember: missing,
    });
    return false;
  }
  if (createHash("sha256").update(code).digest("hex") !== published.sha256) {
    await fail(
      vm,
      version,
      "sha256 файла не совпал с BROWSER_VM_WORKER",
      new Error("The published worker does not match its checksum."),
      { remember: true }
    );
    return false;
  }

  let accepted: boolean;
  try {
    await updateBrowserVmWorkerCode(
      vm,
      code,
      published.sha256,
      Math.max(1_000, deadline - Date.now() - upWaitMs / 2)
    );
    accepted = true;
  } catch (error) {
    if (error instanceof BrowserVmWorkerError) {
      // A run started meanwhile: the next errand on an idle VM tries again.
      if (error.status === 409) return false;
      // The worker checked the code and refused it: it does not load (or
      // lacks what it imports lazily) on this VM's image.
      await fail(vm, version, "worker отверг код", error, {
        remember: error.status === 400,
      });
      return false;
    }
    // No answer: the code may have landed all the same. Whether it did
    // shows in the health check.
    accepted = false;
  }

  const up = await awaitVersion(vm, version, deadline);
  if (up) {
    console.info("[browser-vm] the worker was updated", {
      version,
      was: health.worker,
      workspaceId: vm.workspaceId,
    });
    return true;
  }
  await fail(
    vm,
    version,
    "новая версия не ответила вовремя",
    new Error(
      accepted
        ? "The worker took the code, but the new version did not come up."
        : "The worker did not answer the update, nor come up in the new version."
    ),
    // Taken and not up: the code fails to start (systemd rolls it back).
    // Unanswered: it may never have arrived.
    { remember: accepted }
  );
  return true;
}

/**
 * Whether `published` should replace `running`: another version, and not
 * an older one when both are dated (a VM from a newer image, or one fixed
 * by hand, keeps its worker).
 */
function newer(published: string, running: string) {
  if (published === running) return false;
  const next = datedVersion.exec(published)?.groups;
  const current = datedVersion.exec(running)?.groups;
  if (
    next?.day === undefined ||
    next.count === undefined ||
    current?.day === undefined ||
    current.count === undefined
  ) {
    return true;
  }
  return next.day === current.day
    ? Number(next.count) > Number(current.count)
    : next.day > current.day;
}

function since(at: Date | null, now: Date) {
  return at === null ? Number.POSITIVE_INFINITY : now.getTime() - at.getTime();
}

/** Whether the worker answers in `version` before the deadline. */
async function awaitVersion(vm: BrowserVm, version: string, deadline: number) {
  const until = Math.min(deadline, Date.now() + upWaitMs);
  for (let poll = 0; Date.now() < until && poll < 30; poll += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The worker restarts meanwhile; each check waits for the previous one.
    await sleep(upPollMs);
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      const health = await readBrowserVmWorkerHealth(vm);
      if (health.worker === version) return true;
    } catch {
      // Restarting: no answer, or Caddy's 502 in front of it.
    }
  }
  return false;
}

/**
 * Log the failure, write the version down on the VM when it is the
 * publication's fault or the code's, and tell the owner once per version:
 * a failure that is remembered under its own key, so a passing one before
 * it does not silence it.
 */
async function fail(
  vm: BrowserVm,
  version: string,
  reason: string,
  cause: unknown,
  { remember }: { readonly remember: boolean }
) {
  warn(`the worker could not be updated: ${reason}`, cause, vm, version);
  if (remember) {
    try {
      await updateBrowserVm(
        vm.workspaceId,
        { workerFailedVersion: version },
        new Date(),
        vm.leaseUntil ?? undefined
      );
    } catch (error) {
      warn("the failed version could not be written", error, vm, version);
    }
  }
  try {
    await alertOwner(
      remember
        ? `browser-vm-worker:${version}`
        : `browser-vm-worker:${version}:passing`,
      [
        `Бро не обновил worker браузерной VM до версии ${version}: ${reason}.`,
        remember
          ? "Поручения идут на прежнем worker; на этой VM версию больше не пробуем. Проверь опубликованный файл и BROWSER_VM_WORKER (browser-vm/README.md) и опубликуй новую версию."
          : `Поручения идут на прежнем worker; Бро попробует снова не раньше чем через ${String(retryAfterMs / 60_000)} минут.`,
      ].join("\n"),
      { repeatAfterMs: alertRepeatMs }
    );
  } catch (error) {
    warn("the owner could not be alerted", error, vm, version);
  }
}

function warn(
  text: string,
  cause: unknown,
  vm: BrowserVm,
  version: string | undefined
) {
  console.warn(`[browser-vm] ${text}`, {
    cause,
    version,
    workspaceId: vm.workspaceId,
  });
}
