import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  BrowserStateStoreError,
  readBrowserStateObjectBytes,
} from "@agent/lib/browser-pool/s3";
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
 * worker takes the new code itself (`POST /v1/admin/worker`), checks that it
 * loads, and systemd rolls back code that does not come up.
 *
 * The errand never waits long for it and never fails because of it: a
 * rollout that does not go through leaves the errand on the old worker, the
 * owner hears of it once per version, and a version that failed on a VM is
 * not tried on that VM again (`worker_failed_version`). Sandboxes of the
 * pool are left alone: their worker comes with the root file system.
 */

type BrowserVm = typeof browserVms.$inferSelect;
type WorkerHealth = Awaited<ReturnType<typeof readBrowserVmWorkerHealth>>;

/** The new worker is up within seconds; past this the errand goes on. */
const upPollMs = 2_000;
const upPolls = 12;
const upWaitMs = upPolls * upPollMs;
/**
 * A run record still open after an hour is one nobody read to its end
 * (`openRunWindowMs` of lifecycle.ts): it does not hold a rollout back.
 */
const openRunWindowMs = 60 * 60_000;
/** Once per version: the owner fixes the publication, not each VM. */
const alertRepeatMs = 30 * 24 * 60 * 60_000;

/**
 * The published worker when this VM's worker should get it before the
 * errand: another version answers, no run holds the browser, the VM is a
 * workspace's own (not a sandbox of the pool), and the version has not
 * already failed on it. Asks nothing of anyone.
 */
export function browserVmWorkerDue(vm: BrowserVm, health: WorkerHealth) {
  const published = env.BROWSER_VM_WORKER;
  if (published === undefined) return undefined;
  if (vm.sandboxState !== null || vm.hostId !== null) return undefined;
  if (health.busy || health.worker === published.version) return undefined;
  if (vm.workerFailedVersion === published.version) return undefined;
  return published;
}

/**
 * Roll the published worker out to the VM, as the holder of the lease `vm`
 * was claimed under, so one rollout at a time goes to a VM. Never throws.
 * True once the worker was asked to replace its code (it may be restarting
 * or rolled back since); false when nothing was sent to it.
 */
export async function rollOutBrowserVmWorker(
  vm: BrowserVm,
  health: WorkerHealth,
  now: Date
) {
  const published = browserVmWorkerDue(vm, health);
  if (published === undefined) return false;
  const { version } = published;
  const { workspaceId } = vm;
  try {
    // An open run, or a page an errand keeps for its follow-up: the restart
    // would cut the one and drop what the other holds in memory.
    const [openRuns, holding] = await Promise.all([
      listOpenBrowserVmRuns(workspaceId),
      listWorkspacesHoldingBrowsers([workspaceId], now),
    ]);
    const since = now.getTime() - openRunWindowMs;
    if (
      openRuns.some((run) => run.createdAt.getTime() > since) ||
      holding.length > 0
    ) {
      return false;
    }
  } catch (error) {
    warn("the VM's runs could not be read", error, vm, version);
    return false;
  }

  let code: Uint8Array<ArrayBuffer>;
  try {
    code = await readBrowserStateObjectBytes(published.key);
  } catch (error) {
    // Refused by Object Storage (missing, forbidden): the publication is
    // broken. Anything else may pass: the next errand tries again.
    const broken =
      error instanceof BrowserStateStoreError &&
      error.status >= 400 &&
      error.status < 500;
    await fail(vm, version, "файл не скачался из Object Storage", error, {
      remember: broken,
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
    await updateBrowserVmWorkerCode(vm, code, published.sha256);
    accepted = true;
  } catch (error) {
    if (error instanceof BrowserVmWorkerError) {
      // A run started meanwhile: the next errand on an idle VM tries again.
      if (error.status === 409) return false;
      // The worker checked the code and refused it: it does not load.
      await fail(vm, version, "worker отверг код", error, {
        remember: error.status === 400,
      });
      return false;
    }
    // No answer: the code may have landed all the same. Whether it did
    // shows in the health check.
    accepted = false;
  }

  const up = await awaitVersion(vm, version);
  if (up) {
    console.info("[browser-vm] the worker was updated", {
      version,
      was: health.worker,
      workspaceId,
    });
    return true;
  }
  await fail(
    vm,
    version,
    `новая версия не ответила за ${String(upWaitMs / 1_000)} с`,
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

/** Whether the worker answers in `version` within the wait. */
async function awaitVersion(vm: BrowserVm, version: string) {
  const deadline = Date.now() + upWaitMs;
  for (let poll = 0; poll < upPolls && Date.now() <= deadline; poll += 1) {
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
 * publication's fault or the code's, and tell the owner once per version.
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
      `browser-vm-worker:${version}`,
      [
        `Бро не обновил worker браузерной VM до версии ${version}: ${reason}.`,
        remember
          ? "Поручения идут на прежнем worker; на этой VM версию больше не пробуем. Проверь опубликованный файл и BROWSER_VM_WORKER (browser-vm/README.md) и опубликуй новую версию."
          : "Поручения идут на прежнем worker; следующее поручение попробует снова.",
      ].join("\n"),
      { repeatAfterMs: alertRepeatMs }
    );
  } catch (error) {
    warn("the owner could not be alerted", error, vm, version);
  }
}

function warn(text: string, cause: unknown, vm: BrowserVm, version: string) {
  console.warn(`[browser-vm] ${text}`, {
    cause,
    version,
    workspaceId: vm.workspaceId,
  });
}
