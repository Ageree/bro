import { alertOwner } from "@agent/lib/owner-alert";
import {
  CloudRuError,
  CloudRuUnsentError,
  createCloudRuHostVm,
  deleteCloudRuFloatingIp,
  deleteCloudRuVm,
  findCloudRuVmByName,
  readCloudRuVm,
} from "@agent/lib/browser-vm/cloudru";
import type { browserHosts } from "@db/schema/browser-hosts";
import {
  claimBrowserHostLease,
  claimBrowserHostSlot,
  countLiveSandboxesOnHost,
  deleteBrowserHostRecord,
  listBrowserHosts,
  releaseBrowserHostLease,
  updateBrowserHost,
} from "@db/services/browser-hosts";
import { env } from "@shared/environment";
import {
  browserHostReserveMb,
  readBrowserHostCapacity,
  readBrowserHostHealth,
} from "./host";
import { browserHostKey } from "./keys";
import { presignBrowserStateObject } from "./s3";

/**
 * The hosts of the browser pool (docs/browser-pool.md, section 6): created
 * when a sandbox needs room and no host has it, up to BROWSER_HOST_MAX;
 * set up at boot by cloud-init (`browser-vm/host/boot.py`); watched by the
 * poller's reconcile; deleted with their public address once empty for
 * BROWSER_HOST_IDLE_MINUTES, or once they stop answering. A stopped VM
 * keeps its quota, so a host is never merely stopped.
 *
 * Every step on a host runs under its record's lease, like a workspace's VM
 * (`agent/lib/browser-vm/lifecycle.ts`).
 */

type BrowserHost = typeof browserHosts.$inferSelect;
type BrowserHostCapacity = NonNullable<BrowserHost["capacity"]>;

/** A create, a check or a deletion request is answered well inside this. */
const leaseMs = 2 * 60_000;
/** A host boots and sets itself up in 3–4 minutes, 6 at worst. */
const hostCreateRetryMs = 4 * 60_000;
/** A host on its way up: the errand looks again in a minute. */
const hostBootingRetryMs = 60_000;
/** Every host is full: sandboxes park as their errands end. */
const poolFullRetryMs = 5 * 60_000;
/** Cloud.ru could not be asked (its key, IAM, the project): soon again. */
const unsentRetryMs = 60_000;
/** A create whose answer was lost has made its VM by then, if it made one. */
const lostCreateMs = 5 * 60_000;
/** A VM without an address this long after its create is given up on. */
const createFailAfterMs = 15 * 60_000;
/** `provision.sh`'s budget is 6 minutes; a host not ready by this is failed. */
const bootFailAfterMs = 15 * 60_000;
/** A ready host whose `hostd` did not answer for this long is failed. */
const silentFailAfterMs = 5 * 60_000;
/** A deletion Cloud.ru has not carried out this long after it goes to the owner. */
const deleteAlertAfterMs = 15 * 60_000;
/**
 * How long a failed host's deletion waits for its sandboxes to be taken off
 * it: each is, a reconcile after the host failed, unless a step holds it.
 */
const strandedWaitMs = 10 * 60_000;
/** How long the presigned URLs of the host's cloud-init stay good. */
const bootUrlSeconds = 6 * 60 * 60;
const ownerAlertRepeatMs = 6 * 60 * 60_000;

/**
 * Written by cloud-init: fetches the bundle named in boot.json, checks it
 * and hands over to provision.sh. Byte for byte `BOOT_SCRIPT` of
 * `browser-vm/host/boot.py` (a test compares them).
 */
const bootScript = String.raw`#!/bin/bash
set -euo pipefail
field() { python3 -c 'import json, sys
value = json.load(open("/etc/bro/boot.json"))
for key in sys.argv[1].split("."):
    value = value[key]
print(value)' "$1"; }
URL=$(field bundle.url)
SHA=$(field bundle.sha256)
for i in 1 2 3 4 5; do
  curl -fsS -m 120 -o /root/bro-host.tgz "$URL" && break
  [ "$i" = 5 ] && exit 1
  sleep $((i * 5))
done
echo "$SHA  /root/bro-host.tgz" | sha256sum -c --quiet -
mkdir -p /opt/bro/host
tar -xzf /root/bro-host.tgz -C /opt/bro/host
rm -f /root/bro-host.tgz
exec bash /opt/bro/host/provision.sh
`;

/**
 * The user data one host boots with, as `cloud_init` in
 * `browser-vm/host/boot.py` writes it: the host's id and token key in
 * /etc/bro/host.json, the gVisor release and presigned URLs (with SHA-256)
 * of the host code bundle and the sandbox root in /etc/bro/boot.json, and
 * the boot script that runs `provision.sh`. No Cloud.ru key goes in: the
 * URLs open those two objects only. The domain is left to the host: its
 * address's sslip.io name.
 */
export function browserHostCloudInit(hostId: string, now = new Date()) {
  const bundle = env.BROWSER_HOST_BUNDLE;
  const rootfs = env.BROWSER_SANDBOX_ROOTFS;
  const runscRelease = env.BROWSER_HOST_RUNSC_RELEASE;
  if (
    bundle === undefined ||
    rootfs === undefined ||
    runscRelease === undefined
  ) {
    throw new Error(
      "BROWSER_HOST_BUNDLE, BROWSER_SANDBOX_ROOTFS and BROWSER_HOST_RUNSC_RELEASE are not configured."
    );
  }
  if (!/^[a-z\d-]{1,63}$/u.test(hostId)) {
    throw new Error("A host id matches [a-z0-9-]{1,63}.");
  }
  const url = (key: string) =>
    presignBrowserStateObject({
      expiresSeconds: bootUrlSeconds,
      key,
      method: "GET",
      now,
    });
  const identity = pythonObject([
    ["host", JSON.stringify(hostId)],
    ["key", JSON.stringify(browserHostKey(hostId).toString("hex"))],
  ]);
  const boot = pythonObject([
    ["hostId", JSON.stringify(hostId)],
    ["domain", JSON.stringify("")],
    ["runscRelease", JSON.stringify(runscRelease)],
    [
      "bundle",
      pythonObject([
        ["url", JSON.stringify(url(bundle.key))],
        ["sha256", JSON.stringify(bundle.sha256)],
      ]),
    ],
    [
      "rootfs",
      pythonObject([
        ["version", JSON.stringify(rootfs.version)],
        ["url", JSON.stringify(url(rootfs.key))],
        ["sha256", JSON.stringify(rootfs.sha256)],
      ]),
    ],
  ]);
  const script = bootScript
    .split("\n")
    .map((line) => (line ? `      ${line}\n` : "\n"))
    .join("")
    .replace(/\n+$/u, "");
  return [
    "#cloud-config",
    "write_files:",
    "  - path: /etc/bro/host.json",
    '    permissions: "0600"',
    `    content: ${quoted(identity)}`,
    "  - path: /etc/bro/boot.json",
    '    permissions: "0600"',
    `    content: ${quoted(boot)}`,
    "  - path: /usr/local/sbin/bro-host-boot",
    '    permissions: "0700"',
    "    content: |",
    script,
    "runcmd:",
    '  - [bash, -c, "/usr/local/sbin/bro-host-boot > /var/log/bro-provision.log 2>&1"]',
    "",
  ].join("\n");
}

/**
 * A ready host with room for one more sandbox, or how long the errand
 * should wait for one. Hosts are filled one after another (the fullest
 * that still fits first), so the others empty out and are deleted. With no
 * room anywhere a host is created, within BROWSER_HOST_MAX; past that the
 * owner is told the pool is full.
 *
 * The caller writes the host into the workspace's record before it starts
 * the sandbox there: a host empty for its idle time is first `draining`
 * (placement skips it) and deleted only if it is still empty a reconcile
 * later, so a placement that raced the drain keeps its host.
 */
export async function placeBrowserSandbox(now = new Date()) {
  const hosts = await listBrowserHosts();
  const ready = hosts
    .filter((host) => host.state === "ready" && host.address !== null)
    .toSorted(
      (a, b) => (b.capacity?.committedMb ?? 0) - (a.capacity?.committedMb ?? 0)
    );
  for (const host of ready) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Hosts are asked one at a time, the fullest first, and the first that fits is taken.
    const capacity = await freshCapacity(host);
    if (capacity !== undefined && fits(capacity)) {
      return { host, kind: "ready" as const };
    }
  }
  if (
    hosts.some((host) => host.state === "creating" || host.state === "booting")
  ) {
    return starting(hostBootingRetryMs);
  }
  return starting(await createBrowserHost(now));
}

/**
 * Look after every host once: follow a new one up, check a ready one's
 * `hostd` and its Cloud.ru VM, drain and delete an empty one, delete a
 * failed one. Never throws; a host another step holds is left for the next
 * round.
 */
export async function reconcileBrowserHosts(now = new Date()) {
  const hosts = await listBrowserHosts();
  await Promise.all(
    hosts.map(async (host) => {
      try {
        await reconcileBrowserHost(host.id, now);
      } catch (error) {
        console.warn("[browser-pool] the host could not be reconciled", {
          cause: error,
          hostId: host.id,
          state: host.state,
        });
      }
    })
  );
}

async function reconcileBrowserHost(id: string, now: Date) {
  const host = await claimBrowserHostLease(id, now, leaseMs);
  if (host === undefined) return;
  try {
    switch (host.state) {
      case "creating": {
        await settleCreate(host, now);
        break;
      }
      case "booting": {
        await tendBooting(host, now);
        break;
      }
      case "ready":
      case "draining": {
        await tendReady(host, now);
        break;
      }
      case "failed":
      case "deleting": {
        await removeHost(host, now);
        break;
      }
    }
  } finally {
    await releaseBrowserHostLease(id, host.leaseUntil ?? undefined);
  }
}

/** Take a free slot and ask Cloud.ru for its VM. How long to wait. */
async function createBrowserHost(now: Date) {
  const slot = await claimBrowserHostSlot(env.BROWSER_HOST_MAX, now, leaseMs);
  if (slot === undefined) {
    await alert(
      "browser-pool-full",
      [
        `Все хосты пула браузеров заняты (BROWSER_HOST_MAX = ${String(env.BROWSER_HOST_MAX)}): поручения ждут, пока освободится место.`,
        "Если так часто, подними BROWSER_HOST_MAX (и квоту Cloud.ru) или возьми флейвор побольше.",
      ].join("\n")
    );
    return poolFullRetryMs;
  }
  let cloudInit: string;
  try {
    cloudInit = browserHostCloudInit(slot.id, now);
  } catch (error) {
    // Nothing was asked of Cloud.ru: the slot is free again.
    await deleteBrowserHostRecord(slot.id);
    throw error;
  }
  try {
    const created = await createCloudRuHostVm({
      cloudInit,
      name: slot.vmName,
    });
    await writeHeld(slot, { vmId: created.id }, now);
    return hostCreateRetryMs;
  } catch (error) {
    if (error instanceof CloudRuUnsentError) {
      await deleteBrowserHostRecord(slot.id);
      await alert(
        "cloudru-access",
        `Бро не смог обратиться к Cloud.ru, чтобы создать хост пула браузеров: ${error.message.slice(0, 300)}`
      );
      return unsentRetryMs;
    }
    if (
      error instanceof CloudRuError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      // Refused outright: nothing was created.
      await deleteBrowserHostRecord(slot.id);
      await alert(
        "browser-host-create",
        [
          `Cloud.ru отказал в создании хоста пула браузеров (${String(error.status)}): ${error.body.slice(0, 300)}`,
          "Проверь квоту, BROWSER_HOST_FLAVOR, подсеть и группу безопасности.",
        ].join("\n")
      );
      return poolFullRetryMs;
    }
    // The answer was lost: the VM may exist, and the reconcile finds it by
    // the slot's name.
    await writeHeld(
      slot,
      {
        lastError: `The create of ${slot.vmName} got no answer; the VM may exist.`,
      },
      now
    );
    return hostCreateRetryMs;
  } finally {
    await releaseBrowserHostLease(slot.id, slot.leaseUntil ?? undefined);
  }
}

/** A VM asked for: find it if its answer was lost, take its address. */
async function settleCreate(host: BrowserHost, now: Date) {
  let vmId = host.vmId;
  if (vmId === null) {
    const found = await findCloudRuVmByName(host.vmName);
    if (found === undefined) {
      // No VM by its name after the create had time to land: none was made.
      if (overdue(host, now, lostCreateMs)) {
        await deleteBrowserHostRecord(host.id);
      }
      return;
    }
    vmId = found.id;
    await writeHeld(host, { vmId }, now);
  }
  const cloud = await readCloudRuVm(vmId);
  if (cloud === undefined) {
    await writeHeld(
      host,
      { lastError: "The VM is gone from Cloud.ru.", state: "deleting" },
      now
    );
    return;
  }
  if (cloud.host !== undefined && cloud.state === "running") {
    await writeHeld(
      host,
      {
        address: cloud.host,
        floatingIpId: cloud.floatingIpId ?? null,
        state: "booting",
      },
      now
    );
    return;
  }
  if (overdue(host, now, createFailAfterMs)) {
    await fail(
      host,
      `The VM was ${cloud.state} without an address for ${String(createFailAfterMs / 60_000)} minutes.`,
      now
    );
  }
}

/** A host setting itself up: ready once `provision.sh` says so. */
async function tendBooting(host: BrowserHost, now: Date) {
  const health = await readBrowserHostHealth(host).catch(() => undefined);
  const stage = health?.stage ?? null;
  if (stage === "ready") {
    const capacity = await readBrowserHostCapacity(host);
    await writeHeld(
      host,
      {
        capacity: summary(capacity),
        emptySince: now,
        lastError: null,
        lastSeenAt: now,
        state: "ready",
      },
      now
    );
    return;
  }
  if (stage?.startsWith("failed") === true) {
    await fail(host, `The host did not set itself up: ${stage}.`, now);
    return;
  }
  if (overdue(host, now, bootFailAfterMs)) {
    await fail(
      host,
      `The host was not ready ${String(bootFailAfterMs / 60_000)} minutes after it got its address (stage ${stage ?? "unknown"}).`,
      now
    );
    return;
  }
  if (health !== undefined) await writeHeld(host, { lastSeenAt: now }, now);
}

/**
 * A ready (or draining) host: still the VM Bro created at the address it
 * knows, `hostd` answering, and either holding sandboxes or empty. Empty
 * for the idle time it drains; still empty a round later it is deleted.
 */
async function tendReady(host: BrowserHost, now: Date) {
  const cloud = host.vmId === null ? undefined : await readCloudRuVm(host.vmId);
  if (cloud === undefined || cloud.host !== host.address) {
    // Deleted by hand, or its address moved: an answer at the old address
    // would be some other VM's.
    await fail(host, "The host's VM is gone or has another address.", now);
    return;
  }
  const capacity = await readBrowserHostCapacity(host).catch(() => undefined);
  if (capacity === undefined) {
    const seen = host.lastSeenAt ?? host.stateChangedAt;
    if (now.getTime() - seen.getTime() >= silentFailAfterMs) {
      await fail(host, "The host's hostd stopped answering.", now);
    }
    return;
  }
  const held = summary(capacity);
  const live = await countLiveSandboxesOnHost(host.id);
  if (live > 0 || held.sandboxes > 0) {
    await writeHeld(
      host,
      { capacity: held, emptySince: null, lastSeenAt: now, state: "ready" },
      now
    );
    return;
  }
  const emptySince = host.emptySince ?? now;
  if (host.state === "draining") {
    const deleting = await writeHeld(
      host,
      { capacity: held, lastSeenAt: now, state: "deleting" },
      now
    );
    await removeHost(deleting, now);
    return;
  }
  const idle =
    now.getTime() - emptySince.getTime() >=
    env.BROWSER_HOST_IDLE_MINUTES * 60_000;
  await writeHeld(
    host,
    {
      capacity: held,
      emptySince,
      lastSeenAt: now,
      state: idle ? "draining" : "ready",
    },
    now
  );
}

/**
 * Delete the host's VM with its public address, and then the record once
 * Cloud.ru no longer has the VM. Whatever the host held dies with its disk;
 * the sets in Object Storage are what its sandboxes come back from.
 */
async function removeHost(host: BrowserHost, now: Date) {
  // The sandboxes still placed here are taken back to their sets first
  // (`reconcileBrowserPool`): once the VM and its address go, the address
  // may answer for another VM, and nothing of theirs must go there.
  if (
    (await countLiveSandboxesOnHost(host.id)) > 0 &&
    !overdue(host, now, strandedWaitMs)
  ) {
    return false;
  }
  const deleting =
    host.state === "deleting"
      ? host
      : await writeHeld(host, { state: "deleting" }, now);
  const cloud =
    deleting.vmId === null
      ? await findCloudRuVmByName(deleting.vmName)
      : await readCloudRuVm(deleting.vmId);
  if (cloud !== undefined) {
    const floatingIpId = deleting.floatingIpId ?? cloud.floatingIpId;
    await deleteCloudRuVm(cloud.id, {
      diskIds: [],
      floatingIpIds: floatingIpId === undefined ? [] : [floatingIpId],
    });
    if (overdue(deleting, now, deleteAlertAfterMs)) {
      await alert(
        "browser-host-delete",
        `Cloud.ru уже ${String(deleteAlertAfterMs / 60_000)} минут не удаляет хост пула браузеров ${deleting.vmName}: он может стоить денег, проверь консоль.`
      );
    }
    return false;
  }
  if (deleting.floatingIpId !== null) {
    await deleteCloudRuFloatingIp(deleting.floatingIpId);
  }
  await deleteBrowserHostRecord(deleting.id);
  return true;
}

async function fail(host: BrowserHost, reason: string, now: Date) {
  await writeHeld(host, { lastError: reason, state: "failed" }, now);
  await alert(
    `browser-host-failed:${host.id}`,
    `Хост пула браузеров ${host.vmName} выведен из работы и будет удалён: ${reason}`
  );
}

/** Whether one more sandbox fits the host, by the limits `hostd` admits by. */
function fits(capacity: BrowserHostCapacity) {
  const rootfs = env.BROWSER_SANDBOX_ROOTFS;
  return (
    rootfs !== undefined &&
    capacity.rootfsVersions.includes(rootfs.version) &&
    capacity.limitMb - capacity.committedMb >= env.BROWSER_SANDBOX_MEMORY_MB
  );
}

async function freshCapacity(host: BrowserHost) {
  try {
    return summary(await readBrowserHostCapacity(host));
  } catch (error) {
    console.warn("[browser-pool] the host did not report its capacity", {
      cause: error,
      hostId: host.id,
    });
    return undefined;
  }
}

/** What Bro keeps of a capacity report. */
function summary(
  capacity: Awaited<ReturnType<typeof readBrowserHostCapacity>>
): BrowserHostCapacity {
  return {
    committedMb: capacity.memoryMb?.committed ?? 0,
    limitMb: Math.max(
      (capacity.memoryMb?.total ?? 0) - browserHostReserveMb,
      0
    ),
    rootfsVersions: capacity.rootfsVersions,
    runsc: capacity.runsc,
    sandboxes: capacity.sandboxes.filter(
      (sandbox) => sandbox.state !== "parked" && sandbox.state !== "failed"
    ).length,
  };
}

function starting(retryAfterMs: number) {
  return { kind: "starting" as const, retryAfterMs };
}

function overdue(host: BrowserHost, now: Date, afterMs: number) {
  return now.getTime() - host.stateChangedAt.getTime() >= afterMs;
}

async function writeHeld(
  host: BrowserHost,
  patch: Parameters<typeof updateBrowserHost>[1],
  now: Date
) {
  return updateBrowserHost(host.id, patch, now, host.leaseUntil ?? undefined);
}

/** A single-quoted YAML scalar: a quote inside is written twice. */
function quoted(text: string) {
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * JSON as Python's `json.dumps` writes it (`", "` and `": "` between
 * items), so the user data is byte for byte what `boot.py` would write.
 */
function pythonObject(entries: readonly (readonly [string, string])[]) {
  return `{${entries
    .map(([key, json]) => `${JSON.stringify(key)}: ${json}`)
    .join(", ")}}`;
}

/** Never throws: a host step must not fail because the owner was not told. */
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
