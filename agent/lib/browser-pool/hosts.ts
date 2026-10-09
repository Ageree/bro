import { browserPoolConfigured } from "@agent/lib/browser-vm/backend";
import { alertOwner, clearOwnerAlert } from "@agent/lib/owner-alert";
import {
  CloudRuError,
  CloudRuUnsentError,
  createCloudRuHostVm,
  deleteCloudRuFloatingIp,
  deleteCloudRuVm,
  findCloudRuVmByName,
  readCloudRuVm,
  setCloudRuVmPower,
} from "./cloud";
import type { browserHosts } from "@db/schema/browser-hosts";
import {
  claimBrowserHostLease,
  claimBrowserHostSlot,
  countLiveSandboxesOnHost,
  deleteBrowserHostRecord,
  insertStaticBrowserHost,
  listBrowserHosts,
  readBrowserHost,
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
import { presignStoredObject } from "@shared/object-storage/s3";

/**
 * The hosts of the browser pool (docs/browser-pool.md, section 6): created
 * when a sandbox needs room and no host has it, up to BROWSER_HOST_MAX;
 * set up at boot by cloud-init (`browser-vm/host/boot.py`); watched by the
 * poller's reconcile. Once empty for BROWSER_HOST_IDLE_MINUTES a host still
 * on the current bundle, root and runtime is powered off with its disk and
 * address (`stopped`), and powered on again for the next sandbox (`waking`):
 * on 04.10 in `ru.AZ-1` that took 92 s to `ready`, a new host 288 s, and
 * the first errand after a quiet hour had waited for a new one for 16
 * minutes. A stopped VM bills only its disk and address, but keeps its
 * quota, so any other host is deleted with its public address, as is one
 * that stops answering or sleeps past `sleepLimitMs`. BROWSER_HOST_MIN_WARM
 * hosts on the current boot config never sleep, within
 * BROWSER_HOST_WARM_HOURS, and the reconcile wakes or creates one when
 * fewer are up (`keptWarm`, `keepWarmHostsUp`).
 *
 * Every step on a host runs under its record's lease, like a workspace's VM
 * (`agent/lib/browser-vm/lifecycle.ts`).
 *
 * With BROWSER_HOST_CLOUD=`static` the hosts are servers an operator
 * provisioned once and listed in BROWSER_HOST_STATIC, and none of the above
 * about VMs applies: Bro creates, powers, reboots and deletes nothing, and
 * never asks Cloud.ru about a host (`reconcileStaticHosts`). A listed host is
 * recorded `booting`, `ready` once its `hostd` answers, `failed` when it goes
 * silent and `ready` again as soon as it answers; it never drains or sleeps,
 * whatever the idle time or the warm hours say, and is never created past the
 * list. A pool of them with no room says so and asks again soon: there is no
 * host on its way up to wait for.
 */

type BrowserHost = typeof browserHosts.$inferSelect;
type BrowserHostCapacity = NonNullable<BrowserHost["capacity"]>;

/** A create, a check or a deletion request is answered well inside this. */
const leaseMs = 2 * 60_000;
/**
 * After a create the errand first looks again this long later: no new host
 * was up sooner (127 s in `ru.AZ-3`, 288 s in `ru.AZ-1` on 04.10, 16 minutes
 * at worst); from then on it looks as for a host on its way up.
 */
const hostCreateRetryMs = 2 * 60_000;
/**
 * A host on its way up: the errand looks again this soon, so it starts
 * within seconds of the host coming up rather than up to a minute later
 * (docs/browser-speed.md, section 6). A look asks Cloud.ru and `hostd` only
 * once the host's last step is `risingCheckMs` old.
 */
const hostBootingRetryMs = 15_000;
/**
 * A stopped host powered on again: `running` after about 77 s and `hostd`
 * ready after about 92 (04.10, `ru.AZ-1`, `gen-2-8`), 48 s in `ru.AZ-3`. The
 * errand first looks when a look may ask about it (`risingCheckMs`), then
 * as for a host on its way up.
 */
const hostWakeRetryMs = 45_000;
/**
 * A host on its way up is asked about by a placement only this long after
 * its last step: none woke in under 77 s, nor booted to `hostd` in under 60.
 */
const risingCheckMs = 45_000;
/** A woken host not ready this long after its power-on is failed. */
const wakeFailAfterMs = 10 * 60_000;
/**
 * A power change Cloud.ru has not carried out this long after it was asked
 * for is asked for again: a power-off took 23 s, a power-on 77 s.
 */
const powerRetryMs = 4 * 60_000;
/**
 * A host asleep this long is deleted: its disk and address bill about 600 ₽
 * a month while nobody uses the pool, and a new host is five minutes away.
 */
const sleepLimitMs = 7 * 24 * 60 * 60_000;
/**
 * How long a new host takes to `ready`, as the person hears it: 288 s on
 * 04.10, and up to 16 minutes when its first boot had to be rebooted.
 */
const newHostMinutes = 6;
/** How long a host takes from its VM running to `ready`: 132 s on 04.10. */
const bootingMinutes = 3;
/** How long a sleeping host takes to wake, as the person hears it. */
const wakeMinutes = 2;
/** Every host is full: sandboxes park as their errands end. */
const poolFullRetryMs = 5 * 60_000;
/** The clock BROWSER_HOST_WARM_HOURS is read on: the owner's. */
const warmHoursTimeZone = "Europe/Moscow";
/** Cloud.ru could not be asked (its key, IAM, the project): soon again. */
const unsentRetryMs = 60_000;
/**
 * A create whose answer was lost has made its VM by then, if it made one:
 * Cloud.ru's listing may lag the create by minutes, and a record dropped
 * too early leaves a VM nobody tracks.
 */
const lostCreateMs = 15 * 60_000;
/** A VM without an address this long after its create is given up on. */
const createFailAfterMs = 15 * 60_000;
/**
 * A new VM's `hostd` answers about a minute after it runs (30.09: 33–82 s),
 * but one first boot in three or four hangs in `(initramfs)` and never
 * does; a reboot cures it (134 s to `ready` after it). A booting host that
 * has not answered at all this long after its VM ran is rebooted, once. Not
 * sooner: `hostd` and Caddy start only after apt and the venv, so a slow
 * mirror is silent too, and a reboot mid-provision costs a second run of
 * `provision.sh` (`bro-host-boot` starts it again at the next boot, see
 * `bootScript`). Its whole budget is 6 minutes at worst (boot.py), and
 * `hostd` answers before its end.
 */
const silentBootRebootMs = 6 * 60_000;
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
/**
 * How long the presigned URLs of the host's cloud-init stay good: the host
 * fetches both at its first boot, within minutes. The user data keeps the
 * host's token key for good, so it is treated as a secret of the host.
 */
const bootUrlSeconds = 60 * 60;
/**
 * No host is created for this long after one failed before it was ready:
 * a boot that fails every time would otherwise create, bill and delete a
 * host in a loop while errands wait.
 */
const createCooldownMs = 30 * 60_000;
const ownerAlertRepeatMs = 6 * 60 * 60_000;

/**
 * The apt mirror a host installs from (`APT_MIRROR` of boot.py): from
 * Cloud.ru archive.ubuntu.com does not answer.
 */
const hostAptMirror = "http://mirror.yandex.ru/ubuntu";

/** Where cloud-init writes `bootScript`: `BOOT_SCRIPT_PATH` of boot.py. */
const bootScriptPath = "/var/lib/cloud/scripts/per-boot/bro-host-boot";

/**
 * Fetches the bundle named in boot.json, checks it and hands over to
 * provision.sh. Byte for byte `BOOT_SCRIPT` of `browser-vm/host/boot.py`
 * (a test compares them). A cloud-init per-boot script: it runs at every
 * boot, the first one included, and does nothing once the host is ready.
 * So a reboot that lands mid-provision (`silentBootRebootMs`) sets the host
 * up again: `runcmd`, which cloud-init marks done before it runs it, left
 * such a host dead on 02.10. Cloud.ru's reboot is a hard reset, and the run
 * it cut short may have left torn files: the apt lists and cache and the
 * venv go before provision.sh runs again, and dpkg is repaired. The fetch
 * waits 7–13 minutes for the network: in `ru.AZ-1` a new VM runs this while
 * its public address is still being attached, without DNS or egress for 3+
 * minutes.
 */
const bootScript = String.raw`#!/bin/bash
set -euo pipefail
exec >>/var/log/bro-provision.log 2>&1
STAGE=$(cat /srv/bro/stage 2>/dev/null || echo none)
echo "bro-host-boot $(date -u +%FT%TZ) stage $STAGE"
if [ "$STAGE" = ready ]; then
  exit 0
fi
field() { python3 -c 'import json, sys
value = json.load(open("/etc/bro/boot.json"))
for key in sys.argv[1].split("."):
    value = value[key]
print(value)' "$1"; }
URL=$(field bundle.url)
SHA=$(field bundle.sha256)
for i in $(seq 1 40); do
  curl -fsS --connect-timeout 10 -m 300 -o /root/bro-host.tgz "$URL" && break
  [ "$i" = 40 ] && exit 1
  sleep 10
done
echo "$SHA  /root/bro-host.tgz" | sha256sum -c --quiet -
mkdir -p /opt/bro/host
tar -xzf /root/bro-host.tgz -C /opt/bro/host
rm -f /root/bro-host.tgz
if [ -e /srv/bro/stage ]; then
  systemctl stop bro-hostd 2>/dev/null || true
  rm -rf /opt/bro/venv /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
  for i in 1 2 3 4 5 6; do
    DEBIAN_FRONTEND=noninteractive dpkg --configure -a && break
    [ "$i" = 6 ] && { echo "bro-host-boot: dpkg --configure -a failed 6 times, no provisioning"; exit 1; }
    sleep 10
  done
fi
exec bash /opt/bro/host/provision.sh
`;

/**
 * The user data one host boots with, as `cloud_init` in
 * `browser-vm/host/boot.py` writes it: the host's id and token key in
 * /etc/bro/host.json; the runtime (and, for runsc only, the pinned gVisor
 * release), the apt mirror and presigned URLs (with SHA-256) of the host
 * code bundle and the sandbox root in /etc/bro/boot.json; and the boot
 * script that runs `provision.sh`. No Cloud.ru key goes in: the URLs open
 * those two objects only. The domain is left to the host: its address's
 * sslip.io name.
 */
export function browserHostCloudInit(hostId: string, now = new Date()) {
  const bundle = env.BROWSER_HOST_BUNDLE;
  const rootfs = env.BROWSER_SANDBOX_ROOTFS;
  const { runscRelease, runtime } = hostRuntime();
  if (bundle === undefined || rootfs === undefined) {
    throw new Error(
      "BROWSER_HOST_BUNDLE and BROWSER_SANDBOX_ROOTFS are not configured."
    );
  }
  if (runscRelease === undefined) {
    throw new Error(
      "BROWSER_HOST_RUNTIME is runsc, and BROWSER_HOST_RUNSC_RELEASE is not configured."
    );
  }
  if (!/^[a-z\d-]{1,63}$/u.test(hostId)) {
    throw new Error("A host id matches [a-z0-9-]{1,63}.");
  }
  const url = (key: string) =>
    presignStoredObject({
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
    ["runtime", JSON.stringify(runtime)],
    ["runscRelease", JSON.stringify(runscRelease)],
    ["aptMirror", JSON.stringify(hostAptMirror)],
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
    `  - path: ${bootScriptPath}`,
    '    permissions: "0700"',
    "    content: |",
    script,
    "",
  ].join("\n");
}

/** The runtime a new host boots with, and its gVisor release under runsc. */
function hostRuntime() {
  // Unset, as before the setting: runsc with a pinned release.
  const runtime =
    env.BROWSER_HOST_RUNTIME ??
    (env.BROWSER_HOST_RUNSC_RELEASE === undefined ? "runc" : "runsc");
  const runscRelease =
    runtime === "runsc" ? env.BROWSER_HOST_RUNSC_RELEASE : "";
  return { runscRelease, runtime };
}

/**
 * What a host created now boots with: the bundle, the sandbox root and the
 * runtime its cloud-init names. A sleeping host wakes as it was set up, so
 * only one still on these is put to sleep or woken (`onCurrentBoot`).
 */
function browserHostBootConfig() {
  const bundle = env.BROWSER_HOST_BUNDLE;
  const rootfs = env.BROWSER_SANDBOX_ROOTFS;
  if (bundle === undefined || rootfs === undefined) return null;
  const { runscRelease, runtime } = hostRuntime();
  return [
    bundle.sha256,
    rootfs.version,
    rootfs.sha256,
    runtime,
    runscRelease ?? "",
  ].join(":");
}

/** Whether the host was set up as a new one would be now. */
function onCurrentBoot(host: BrowserHost) {
  return (
    host.bootConfig !== null && host.bootConfig === browserHostBootConfig()
  );
}

/** Whether the hosts are the operator's servers, not Cloud.ru VMs. */
function staticMode() {
  return env.BROWSER_HOST_CLOUD === "static";
}

function staticEntry(id: string) {
  return staticMode()
    ? env.BROWSER_HOST_STATIC?.find((entry) => entry.id === id)
    : undefined;
}

/**
 * Whether the host is one of BROWSER_HOST_STATIC's, recorded as such: no VM
 * and no floating IP behind it. A record of the same id with a Cloud.ru VM
 * is a leftover of the `cloudru` mode and is not one.
 */
export function isStaticBrowserHost(
  host: Pick<BrowserHost, "floatingIpId" | "id" | "vmId">
) {
  return (
    staticEntry(host.id) !== undefined &&
    host.vmId === null &&
    host.floatingIpId === null
  );
}

/** Whether a sandbox may be placed on the host at all. */
function placeable(host: BrowserHost) {
  return !staticMode() || isStaticBrowserHost(host);
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
 * and deleted only if it is still empty a reconcile later, so a placement
 * that raced the drain keeps its host; a placement may also take an empty
 * draining host back (`backInService`). With `inServiceOnly` (a warm-up,
 * `prewarmBrowserSandbox` in `sandbox.ts`) it takes a host in service or
 * none: waking or creating one is `prewarmBrowserPool`'s.
 */
export async function placeBrowserSandbox(
  now = new Date(),
  { inServiceOnly = false }: { readonly inServiceOnly?: boolean } = {}
) {
  // In the `static` mode a record outside the list takes no sandbox.
  const hosts = (await listBrowserHosts()).filter(placeable);
  // The ready hosts, fullest first; then the draining ones, which an empty
  // host is before it is deleted: taking one back is quicker than a new one.
  const serving = hosts
    .filter(
      (host) =>
        (host.state === "ready" || host.state === "draining") &&
        host.address !== null
    )
    .toSorted(
      (a, b) =>
        Number(a.state === "draining") - Number(b.state === "draining") ||
        (b.capacity?.committedMb ?? 0) - (a.capacity?.committedMb ?? 0)
    );
  // What the hosts said just now, for the reasons a new host is needed.
  const read = new Map<string, BrowserHostCapacity>();
  for (const host of serving) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Hosts are asked one at a time, the fullest first, and the first that fits is taken.
    const capacity = await freshCapacity(host);
    if (capacity !== undefined) read.set(host.id, capacity);
    if (capacity === undefined || !fits(capacity)) continue;
    if (host.state === "ready") return { host, kind: "ready" as const };
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above: the first host that fits is taken.
    const revived = await backInService(host, now);
    if (revived !== undefined) return { host: revived, kind: "ready" as const };
  }
  if (inServiceOnly) return starting(hostBootingRetryMs);
  const rising = hosts.filter(onItsWayUp);
  if (rising.length > 0) {
    // One that came up since the reconcile serves now, not a minute later:
    // the poller drains the queue before it reconciles the hosts. One that
    // only just began cannot be up, and asking its silent `hostd` would
    // hold a person's `browser_task` for the health check's timeout.
    const due = rising.filter(
      (host) => now.getTime() - host.stateChangedAt.getTime() >= risingCheckMs
    );
    await Promise.all(
      due.map(async (host) => {
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
    for (const id of due.map((host) => host.id)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Hosts on their way up are few, and the first ready one is taken.
      const risen = await readBrowserHost(id);
      const room = risen?.state === "ready" ? risen.capacity : null;
      if (risen !== undefined && room !== null && fits(room)) {
        return { host: risen, kind: "ready" as const };
      }
    }
    return starting(hostBootingRetryMs);
  }
  // Static hosts are always on: none is woken or made for the errand.
  if (staticMode()) return starting(await staticNoRoom(hosts, read));
  // A sleeping host is up in a minute and a half, a new one in five.
  const sleeping = hosts.find((host) => host.state === "stopped");
  if (sleeping !== undefined)
    return starting(await wakeBrowserHost(sleeping, now));
  return starting(await createBrowserHost(hosts, read, now));
}

function onItsWayUp(host: BrowserHost) {
  return (
    host.state === "creating" ||
    host.state === "booting" ||
    host.state === "waking"
  );
}

/**
 * Get the pool ready for a person who just wrote: their next errand may
 * need a browser, and a host takes a minute and a half to wake and five to
 * create, longer than the model takes to start the errand. A host on its
 * way up, or a ready one, is left as it is; an empty draining one is taken
 * back into service. Never throws: the turn goes on whatever Cloud.ru says.
 */
export async function prewarmBrowserPool(now = new Date()) {
  // Static hosts are always on: there is nothing to warm up.
  if (staticMode()) return;
  try {
    const hosts = await listBrowserHosts();
    if (hosts.some((host) => host.state === "ready" || onItsWayUp(host))) {
      return;
    }
    const draining = hosts.find(
      (host) => host.state === "draining" && host.address !== null
    );
    if (draining !== undefined) {
      await backInService(draining, now);
      return;
    }
    await placeBrowserSandbox(now);
  } catch (error) {
    console.warn("[browser-pool] the pool could not be warmed up", {
      cause: error,
    });
  }
}

/**
 * About how many minutes a sandbox start waits for its host now, and why,
 * as the person hears it (`agent/lib/browser-use/queue.ts`): a host in
 * service starts a sandbox in seconds; a sleeping one wakes in a minute and
 * a half; a new one is up about six minutes after its create (three after
 * its VM runs), so one on its way is told what is left of that, and a
 * create held back after a failed boot (`createCooldownMs`) adds its wait.
 * A sleeping host set up otherwise than a new one is replaced, not woken.
 */
export async function browserPoolWait(now = new Date()) {
  // Static hosts are always on, so a start waits for room, never for a host.
  if (staticMode()) return { minutes: 1, phase: "ready" as const };
  const hosts = await listBrowserHosts();
  if (
    hosts.some(
      (host) =>
        (host.state === "ready" || host.state === "draining") &&
        host.address !== null
    )
  ) {
    return { minutes: 1, phase: "ready" as const };
  }
  if (
    hosts.some(
      (host) =>
        host.state === "waking" ||
        (host.state === "stopped" && onCurrentBoot(host))
    )
  ) {
    return { minutes: wakeMinutes, phase: "waking" as const };
  }
  const coming = hosts.find(
    (host) => host.state === "creating" || host.state === "booting"
  );
  if (coming !== undefined) {
    // From its create, or from its VM running for one already booting.
    const total = coming.state === "creating" ? newHostMinutes : bootingMinutes;
    const left = Math.ceil(
      (coming.stateChangedAt.getTime() + total * 60_000 - now.getTime()) /
        60_000
    );
    return {
      minutes: Math.min(Math.max(left, 2), newHostMinutes),
      phase: "new" as const,
    };
  }
  const cooling = Math.max(
    0,
    ...hosts.map(
      (host) => (host.createBlockedUntil?.getTime() ?? 0) - now.getTime()
    )
  );
  return {
    minutes: newHostMinutes + Math.ceil(cooling / 60_000),
    phase: "new" as const,
  };
}

/**
 * Power a sleeping host on for a placement, under its lease. One no longer
 * on the current bundle, root or runtime is deleted instead, and the slot
 * it gives back takes a new host. How long the errand should wait.
 */
async function wakeBrowserHost(host: BrowserHost, now: Date) {
  const claimed = await claimBrowserHostLease(host.id, now, leaseMs);
  if (claimed === undefined) return hostBootingRetryMs;
  try {
    if (claimed.state !== "stopped") return hostBootingRetryMs;
    if (!onCurrentBoot(claimed) || claimed.vmId === null) {
      await removeHost(claimed, now);
      return hostBootingRetryMs;
    }
    const cloud = await readCloudRuVm(claimed.vmId);
    if (cloud === undefined) {
      await writeHeld(
        claimed,
        { lastError: "The VM is gone from Cloud.ru.", state: "deleting" },
        now
      );
      return hostBootingRetryMs;
    }
    if (cloud.state !== "running") {
      try {
        await setCloudRuVmPower(cloud.id, "power_on");
      } catch (error) {
        // Still powering off, or Cloud.ru busy: the next try asks again.
        console.warn("[browser-pool] a sleeping host did not power on", {
          cause: error,
          hostId: claimed.id,
          state: cloud.state,
        });
        return hostBootingRetryMs;
      }
    }
    await writeHeld(claimed, { lastError: null, state: "waking" }, now);
    return hostWakeRetryMs;
  } finally {
    await releaseBrowserHostLease(claimed.id, claimed.leaseUntil ?? undefined);
  }
}

/**
 * Put a draining host back in service for a placement, under its lease, as
 * if it had just emptied: the reconcile deletes a draining host only while
 * it holds its lease, so one taken back here is not deleted under the
 * sandbox. Undefined when another step holds it or it is on its way out.
 */
async function backInService(host: BrowserHost, now: Date) {
  const claimed = await claimBrowserHostLease(host.id, now, leaseMs);
  if (claimed === undefined) return undefined;
  try {
    if (claimed.state !== "draining" && claimed.state !== "ready") {
      return undefined;
    }
    return await writeHeld(claimed, { emptySince: now, state: "ready" }, now);
  } finally {
    await releaseBrowserHostLease(host.id, claimed.leaseUntil ?? undefined);
  }
}

/**
 * Look after every host once: follow a new one up, check a ready one's
 * `hostd` and its Cloud.ru VM, drain and delete an empty one (but those
 * BROWSER_HOST_MIN_WARM keeps, `keptWarm`), delete a failed one; then wake
 * or create a host if fewer than the minimum are up (`keepWarmHostsUp`).
 * Never throws; a host another step holds is left for the next round.
 */
export async function reconcileBrowserHosts(now = new Date()) {
  if (staticMode()) {
    await reconcileStaticHosts(now);
    return;
  }
  const hosts = await listBrowserHosts();
  const warm = keptWarm(hosts, now);
  await Promise.all(
    hosts.map(async (host) => {
      try {
        await reconcileBrowserHost(host.id, now, warm.has(host.id));
      } catch (error) {
        console.warn("[browser-pool] the host could not be reconciled", {
          cause: error,
          hostId: host.id,
          state: host.state,
        });
      }
    })
  );
  try {
    await keepWarmHostsUp(now);
  } catch (error) {
    console.warn("[browser-pool] a host could not be kept warm", {
      cause: error,
    });
  }
}

/**
 * How many hosts BROWSER_HOST_MIN_WARM keeps up at `now`: none outside
 * BROWSER_HOST_WARM_HOURS (Moscow time) or while the pool is not configured
 * (hosts left over are only looked after then), and never more than
 * BROWSER_HOST_MAX.
 */
function warmHostsWanted(now: Date) {
  const wanted = Math.min(env.BROWSER_HOST_MIN_WARM, env.BROWSER_HOST_MAX);
  if (wanted === 0 || !browserPoolConfigured()) return 0;
  const hours = env.BROWSER_HOST_WARM_HOURS;
  if (hours === undefined) return wanted;
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: warmHoursTimeZone,
    }).format(now)
  );
  const inside =
    hours.from < hours.to
      ? hour >= hours.from && hour < hours.to
      : hour >= hours.from || hour < hours.to;
  return inside ? wanted : 0;
}

/**
 * Whether the host counts towards BROWSER_HOST_MIN_WARM: in service, set up
 * as a new host would be now, with the current sandbox root. A host on an
 * older bundle, root or runtime does not, so it still empties and goes, and
 * a current one takes its place.
 */
function warmable(host: BrowserHost) {
  return (
    (host.state === "ready" || host.state === "draining") &&
    host.address !== null &&
    onCurrentBoot(host) &&
    !outdatedRoot(host.capacity)
  );
}

/**
 * The hosts this round keeps in service however long they have been empty:
 * the BROWSER_HOST_MIN_WARM warmable ones a placement would fill first.
 */
function keptWarm(hosts: readonly BrowserHost[], now: Date) {
  const wanted = warmHostsWanted(now);
  if (wanted === 0) return new Set<string>();
  return new Set(
    hosts
      .filter(warmable)
      .toSorted(
        (a, b) =>
          Number(a.state === "draining") - Number(b.state === "draining") ||
          (b.capacity?.committedMb ?? 0) - (a.capacity?.committedMb ?? 0)
      )
      .slice(0, wanted)
      .map((host) => host.id)
  );
}

/**
 * When a create kept warm last made no host, the next waits until then: a
 * create Cloud.ru refuses (quota) would otherwise be asked for every minute.
 */
let warmCreateAfter = 0;

/**
 * Fewer hosts up, or on their way up, than BROWSER_HOST_MIN_WARM: wake a
 * sleeping one on the current boot config, or create one in a free slot.
 * One host a round. No slot free means a host on an older config holds it
 * until it empties and goes; nothing is created past BROWSER_HOST_MAX.
 */
async function keepWarmHostsUp(now: Date) {
  const wanted = warmHostsWanted(now);
  if (wanted === 0) return;
  const hosts = await listBrowserHosts();
  const up = hosts.filter((host) => warmable(host) || onItsWayUp(host));
  if (up.length >= wanted) return;
  const sleeping = hosts.find(
    (host) => host.state === "stopped" && onCurrentBoot(host)
  );
  if (sleeping !== undefined) {
    await wakeBrowserHost(sleeping, now);
    return;
  }
  if (hosts.length >= env.BROWSER_HOST_MAX) return;
  if (now.getTime() < warmCreateAfter) return;
  const wait = await createBrowserHost(hosts, new Map(), now);
  warmCreateAfter = now.getTime() + wait;
}

async function reconcileBrowserHost(id: string, now: Date, keepWarm = false) {
  const host = await claimBrowserHostLease(id, now, leaseMs);
  if (host === undefined) return;
  try {
    if (staticMode()) {
      await tendStaticMode(host, now);
      return;
    }
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
        await tendReady(host, now, keepWarm);
        break;
      }
      case "stopped": {
        await tendStopped(host, now);
        break;
      }
      case "waking": {
        await tendWaking(host, now);
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

/**
 * The `static` mode's round: record every listed host that has no record,
 * then look after every record, listed or not. Nothing here reaches
 * Cloud.ru.
 */
async function reconcileStaticHosts(now: Date) {
  try {
    const bootConfig = browserHostBootConfig();
    await Promise.all(
      (env.BROWSER_HOST_STATIC ?? []).map(async (entry) =>
        insertStaticBrowserHost(
          { address: entry.address, bootConfig, id: entry.id },
          now
        )
      )
    );
  } catch (error) {
    console.warn("[browser-pool] the static hosts could not be recorded", {
      cause: error,
    });
  }
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

/** The key of a failed static host's alert: one per host, not per VM. */
function staticFailedAlertKey(host: BrowserHost) {
  return `browser-host-failed:${host.id}:static`;
}

/**
 * One record in the `static` mode, under its lease. A listed host is
 * followed up, kept ready and failed or revived by what its `hostd` says;
 * any other record (a host taken off the list, or a Cloud.ru host left over
 * from the `cloudru` mode) takes no new sandbox and goes once it holds none.
 */
async function tendStaticMode(host: BrowserHost, now: Date) {
  const entry = staticEntry(host.id);
  if (entry === undefined || !isStaticBrowserHost(host)) {
    if (entry !== undefined) {
      console.warn(
        "[browser-pool] a listed static host id belongs to a Cloud.ru host's record",
        { hostId: host.id }
      );
    }
    await dropUnlistedHost(host, now);
    return;
  }
  // The operator moved the host to another address: it is looked at anew.
  const current =
    host.address === entry.address
      ? host
      : await writeHeld(
          host,
          {
            address: entry.address,
            capacity: null,
            lastSeenAt: null,
            state: "booting",
          },
          now
        );
  switch (current.state) {
    case "booting": {
      await tendStaticBooting(current, now);
      break;
    }
    case "failed": {
      await tendStaticFailed(current, now);
      break;
    }
    default: {
      await tendStaticReady(current, now);
    }
  }
}

/** A static host nobody has heard from yet: ready once `hostd` says so. */
async function tendStaticBooting(host: BrowserHost, now: Date) {
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
    await failStaticHost(
      host,
      `The host did not set itself up: ${stage}.`,
      now
    );
    return;
  }
  if (overdue(host, now, bootFailAfterMs)) {
    await failStaticHost(
      host,
      `The host was not ready ${String(bootFailAfterMs / 60_000)} minutes after it was recorded (stage ${stage ?? "unknown"}).`,
      now
    );
    return;
  }
  if (health !== undefined) await writeHeld(host, { lastSeenAt: now }, now);
}

/** A failed static host is ready again the moment its `hostd` answers. */
async function tendStaticFailed(host: BrowserHost, now: Date) {
  const capacity = await readBrowserHostCapacity(host).catch(() => undefined);
  if (capacity === undefined) return;
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
  try {
    await clearOwnerAlert(staticFailedAlertKey(host), now);
  } catch (error) {
    console.warn("[browser-pool] the host's alert could not be cleared", {
      cause: error,
      hostId: host.id,
    });
  }
}

/**
 * A ready static host: its `hostd` answers, or it is failed after
 * `silentFailAfterMs`. It stays `ready` however long it is empty. One
 * without the current sandbox root takes only what `fits` lets it, and the
 * owner is told to update it.
 */
async function tendStaticReady(host: BrowserHost, now: Date) {
  const capacity = await readBrowserHostCapacity(host).catch(() => undefined);
  if (capacity === undefined) {
    const seen = host.lastSeenAt ?? host.stateChangedAt;
    if (now.getTime() - seen.getTime() >= silentFailAfterMs) {
      await failStaticHost(host, "The host's hostd stopped answering.", now);
    }
    return;
  }
  const held = summary(capacity);
  if (outdatedRoot(held)) await alertOutdatedStaticHost(host);
  const occupied =
    (await countLiveSandboxesOnHost(host.id)) > 0 || held.sandboxes > 0;
  await writeHeld(
    host,
    {
      capacity: held,
      emptySince: occupied ? null : (host.emptySince ?? now),
      lastError: null,
      lastSeenAt: now,
      state: "ready",
    },
    now
  );
}

/**
 * A record the `static` mode does not serve: it takes no new sandbox
 * (`draining`, which placement ignores here) and its record goes once no
 * sandbox is on it. Bro deletes no VM: a Cloud.ru host left over from the
 * `cloudru` mode keeps running and billing until the operator deletes its VM
 * and floating IP at Cloud.ru.
 */
async function dropUnlistedHost(host: BrowserHost, now: Date) {
  const live = await countLiveSandboxesOnHost(host.id);
  if (host.state === "ready" || host.state === "draining") {
    const draining =
      host.state === "ready"
        ? await writeHeld(host, { state: "draining" }, now)
        : host;
    if (live > 0) return;
    const capacity = await readBrowserHostCapacity(draining).catch(
      () => undefined
    );
    if (capacity !== undefined && summary(capacity).sandboxes > 0) return;
  } else if (live > 0 && !overdue(host, now, strandedWaitMs)) {
    // Its sandboxes are taken back to their sets first, as for a failed host.
    return;
  }
  await deleteBrowserHostRecord(host.id);
}

async function failStaticHost(host: BrowserHost, reason: string, now: Date) {
  console.warn("[browser-pool] a static host failed", {
    hostId: host.id,
    reason,
    state: host.state,
  });
  await writeHeld(host, { lastError: reason, state: "failed" }, now);
  await alert(
    staticFailedAlertKey(host),
    `Хост пула браузеров ${host.id} (${host.address ?? "без адреса"}) не отвечает: ${reason}\nБро с ним ничего не делает: проверь сервер. Как только hostd снова ответит, хост вернётся в работу.`
  );
}

/** One alert per host, repeated as every alert is. */
async function alertOutdatedStaticHost(host: BrowserHost) {
  const rootfs = env.BROWSER_SANDBOX_ROOTFS;
  if (rootfs === undefined) return;
  await alert(
    `browser-host-outdated:${host.id}`,
    [
      `Хост пула браузеров ${host.id} (${host.address ?? "без адреса"}) без корня песочницы ${rootfs.version}: новые песочницы на него не ставятся, пока он не обновлён.`,
      `Бро хосты не обновляет: обнови сервер сам (cloud-init для него печатает scripts/browser-pool/static-host-cloud-init.ts ${host.id}).`,
    ].join("\n")
  );
}

/**
 * No static host has room. Those that answer without the current root are
 * told of (the owner updates them); all of them in service and full is a
 * full pool. Nothing is made or woken: the errand looks again soon, since a
 * sandbox parks whenever an errand ends.
 */
async function staticNoRoom(
  hosts: readonly BrowserHost[],
  read: ReadonlyMap<string, BrowserHostCapacity>
) {
  const answering = hosts.filter((host) => read.has(host.id));
  const outdated = answering.filter((host) =>
    outdatedRoot(read.get(host.id) ?? null)
  );
  await Promise.all(
    outdated.map(async (host) => alertOutdatedStaticHost(host))
  );
  if (answering.length > 0 && outdated.length === 0) {
    await alert(
      "browser-pool-full",
      `Все хосты пула браузеров заняты (BROWSER_HOST_STATIC: ${hosts.map((host) => host.id).join(", ")}): поручения ждут, пока освободится место. Если так часто, добавь хост в BROWSER_HOST_STATIC.`
    );
  }
  return hostBootingRetryMs;
}

/**
 * Take a free slot and ask Cloud.ru for its VM, or adopt the VM of that
 * name a lost create left behind. How long to wait. No host is created
 * while one that failed at boot cools down (`createCooldownMs`).
 */
async function createBrowserHost(
  hosts: readonly BrowserHost[],
  read: ReadonlyMap<string, BrowserHostCapacity>,
  now: Date
) {
  const cooling = hosts
    .map((host) => host.createBlockedUntil?.getTime() ?? 0)
    .filter((until) => until > now.getTime());
  if (cooling.length > 0) {
    return Math.min(Math.max(...cooling) - now.getTime(), poolFullRetryMs);
  }
  const slot = await claimBrowserHostSlot(env.BROWSER_HOST_MAX, now, leaseMs, {
    prefix: env.BROWSER_HOST_NAME_PREFIX,
  });
  if (slot === undefined) return noFreeSlot(hosts, read);
  let cloudInit: string;
  try {
    cloudInit = browserHostCloudInit(slot.id, now);
  } catch (error) {
    // Nothing was asked of Cloud.ru: the slot is free again.
    await deleteBrowserHostRecord(slot.id);
    throw error;
  }
  try {
    // A VM of this name a lost create left behind is taken on, not doubled.
    const left = await findCloudRuVmByName(slot.vmName);
    if (left !== undefined) {
      await writeHeld(
        slot,
        {
          lastError: `${slot.vmName} was already on Cloud.ru: the host goes on with that VM.`,
          vmId: left.id,
        },
        now
      );
      return hostCreateRetryMs;
    }
    const created = await createCloudRuHostVm({
      cloudInit,
      name: slot.vmName,
    });
    await writeHeld(
      slot,
      { bootConfig: browserHostBootConfig(), vmId: created.id },
      now
    );
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
      // Refused outright: nothing was created, unless the listing says so.
      const made = await findCloudRuVmByName(slot.vmName).catch(
        () => undefined
      );
      if (made !== undefined) {
        await writeHeld(slot, { vmId: made.id }, now);
        return hostCreateRetryMs;
      }
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
    // the slot's name. If it does, it boots with this cloud-init.
    await writeHeld(
      slot,
      {
        bootConfig: browserHostBootConfig(),
        lastError: `The create of ${slot.vmName} got no answer; the VM may exist.`,
      },
      now
    );
    return hostCreateRetryMs;
  } finally {
    await releaseBrowserHostLease(slot.id, slot.leaseUntil ?? undefined);
  }
}

/**
 * No slot is free. Hosts on their way out (draining, deleting, failed, or
 * on a sandbox root that is no longer current) give theirs back within
 * minutes, so the errand looks again in one; only a pool whose hosts are
 * all in service and full is reported full.
 */
async function noFreeSlot(
  hosts: readonly BrowserHost[],
  read: ReadonlyMap<string, BrowserHostCapacity>
) {
  const rootfs = env.BROWSER_SANDBOX_ROOTFS;
  const outdated = hosts.filter((host) =>
    outdatedRoot(read.get(host.id) ?? host.capacity)
  );
  if (outdated.length > 0 && rootfs !== undefined) {
    await alert(
      "browser-pool-rootfs",
      [
        `Хосты пула браузеров ${outdated.map((host) => host.vmName).join(", ")} без корня песочницы ${rootfs.version}: они выводятся из работы, когда опустеют, и поручения ждут нового хоста.`,
        "Если ждать долго, удали их вручную или подними BROWSER_HOST_MAX.",
      ].join("\n")
    );
  }
  if (
    outdated.length > 0 ||
    hosts.some(
      (host) =>
        host.state === "draining" ||
        host.state === "deleting" ||
        host.state === "failed"
    )
  ) {
    return hostBootingRetryMs;
  }
  await alert(
    "browser-pool-full",
    [
      `Все хосты пула браузеров заняты (BROWSER_HOST_MAX = ${String(env.BROWSER_HOST_MAX)}): поручения ждут, пока освободится место.`,
      "Если так часто, подними BROWSER_HOST_MAX (и квоту Cloud.ru) или возьми флейвор побольше.",
    ].join("\n")
  );
  return poolFullRetryMs;
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

/**
 * A host setting itself up: ready once `provision.sh` says so. One that has
 * never answered since its VM ran is rebooted once (`silentBootRebootMs`).
 */
async function tendBooting(host: BrowserHost, now: Date) {
  const health = await readBrowserHostHealth(host).catch(() => undefined);
  const stage = health?.stage ?? null;
  if (
    health === undefined &&
    host.lastSeenAt === null &&
    host.rebootedAt === null &&
    host.vmId !== null &&
    overdue(host, now, silentBootRebootMs) &&
    !overdue(host, now, bootFailAfterMs)
  ) {
    await setCloudRuVmPower(host.vmId, "reboot");
    await writeHeld(
      host,
      {
        lastError: `hostd did not answer ${String(silentBootRebootMs / 60_000)} minutes after the VM ran: rebooted once.`,
        rebootedAt: now,
      },
      now
    );
    return;
  }
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
 * for the idle time it drains; still empty a round later it sleeps or is
 * deleted. One BROWSER_HOST_MIN_WARM keeps (`keepWarm`) stays in service
 * however long it is empty, a drained one comes back, and its empty time
 * runs on: once the warm hours end it drains at the next round.
 */
async function tendReady(host: BrowserHost, now: Date, keepWarm: boolean) {
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
  // A host without the current sandbox root takes no new sandbox: it
  // drains, and goes once its sandboxes have parked.
  const outdated = outdatedRoot(held);
  const live = await countLiveSandboxesOnHost(host.id);
  if (live > 0 || held.sandboxes > 0) {
    await writeHeld(
      host,
      {
        capacity: held,
        emptySince: null,
        lastSeenAt: now,
        state: outdated ? "draining" : "ready",
      },
      now
    );
    return;
  }
  const emptySince = host.emptySince ?? now;
  if (keepWarm && !outdated) {
    await writeHeld(
      host,
      { capacity: held, emptySince, lastSeenAt: now, state: "ready" },
      now
    );
    return;
  }
  if (host.state === "draining") {
    if (!outdated && onCurrentBoot(host) && host.vmId !== null) {
      // Written first: a power-off whose answer is lost is asked for again
      // by `tendStopped`, and a placement never takes a stopped host.
      await writeHeld(
        host,
        { capacity: held, lastSeenAt: now, state: "stopped" },
        now
      );
      await setCloudRuVmPower(host.vmId, "power_off");
      return;
    }
    const deleting = await writeHeld(
      host,
      { capacity: held, lastSeenAt: now, state: "deleting" },
      now
    );
    await removeHost(deleting, now);
    return;
  }
  const idle =
    outdated ||
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
 * A sleeping host: powered off, or asked to be. One no longer on the current
 * bundle, root or runtime, or asleep past `sleepLimitMs`, is deleted; one
 * whose VM is gone loses its record (and address); a power-off Cloud.ru did
 * not carry out is asked for again.
 */
async function tendStopped(host: BrowserHost, now: Date) {
  if (
    !onCurrentBoot(host) ||
    host.vmId === null ||
    overdue(host, now, sleepLimitMs)
  ) {
    await removeHost(host, now);
    return;
  }
  const cloud = await readCloudRuVm(host.vmId);
  if (cloud === undefined) {
    await writeHeld(
      host,
      { lastError: "The VM is gone from Cloud.ru.", state: "deleting" },
      now
    );
    return;
  }
  if (cloud.state === "running" && overdue(host, now, powerRetryMs)) {
    await setCloudRuVmPower(cloud.id, "power_off");
  }
}

/**
 * A sleeping host powered on for a sandbox: ready once `hostd` says so, at
 * the address it slept with. A power-on Cloud.ru did not carry out is asked
 * for again; one that is not back in `wakeFailAfterMs` fails, and its slot
 * goes to a new host without the cool-down of a failed first boot.
 */
async function tendWaking(host: BrowserHost, now: Date) {
  const health = await readBrowserHostHealth(host).catch(() => undefined);
  if (health?.stage === "ready") {
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
  const cloud = host.vmId === null ? undefined : await readCloudRuVm(host.vmId);
  if (
    cloud === undefined ||
    (cloud.host !== undefined && cloud.host !== host.address)
  ) {
    await fail(host, "The host's VM is gone or has another address.", now);
    return;
  }
  if (overdue(host, now, wakeFailAfterMs)) {
    await fail(
      host,
      `The host was not back ${String(wakeFailAfterMs / 60_000)} minutes after it was powered on.`,
      now
    );
    return;
  }
  if (cloud.state === "stopped" && overdue(host, now, powerRetryMs)) {
    await setCloudRuVmPower(cloud.id, "power_on");
  }
}

/**
 * Delete the host's VM with its public address, and then the record once
 * Cloud.ru no longer has the VM. Whatever the host held dies with its disk;
 * the sets in Object Storage are what its sandboxes come back from.
 */
async function removeHost(host: BrowserHost, now: Date) {
  // A host that failed at boot and whose VM is gone keeps its slot until
  // its cool-down is over (`createCooldownMs`).
  if (host.vmId === null && coolingAfterBoot(host)) {
    if ((host.createBlockedUntil?.getTime() ?? 0) <= now.getTime()) {
      await deleteBrowserHostRecord(host.id);
      return true;
    }
    return false;
  }
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
    try {
      await deleteCloudRuVm(cloud.id, {
        diskIds: [],
        floatingIpIds: floatingIpId === undefined ? [] : [floatingIpId],
      });
    } finally {
      // Also when Cloud.ru refuses the deletion outright (a VM stuck in
      // `creating` cannot be deleted): the owner must hear of a host that
      // bills on.
      if (overdue(deleting, now, deleteAlertAfterMs)) {
        await alert(
          `browser-host-delete:${deleting.vmName}`,
          `Cloud.ru уже ${String(deleteAlertAfterMs / 60_000)} минут не удаляет хост пула браузеров ${deleting.vmName}: он может стоить денег, проверь консоль.`
        );
      }
    }
    return false;
  }
  if (deleting.floatingIpId !== null) {
    await deleteCloudRuFloatingIp(deleting.floatingIpId);
  }
  if ((deleting.createBlockedUntil?.getTime() ?? 0) > now.getTime()) {
    await writeHeld(
      deleting,
      { address: null, capacity: null, floatingIpId: null, vmId: null },
      now
    );
    return false;
  }
  await deleteBrowserHostRecord(deleting.id);
  return true;
}

/** A failed boot's record, kept after its VM to hold creates back. */
function coolingAfterBoot(host: BrowserHost) {
  return (
    host.createBlockedUntil !== null &&
    host.address === null &&
    host.floatingIpId === null
  );
}

async function fail(host: BrowserHost, reason: string, now: Date) {
  const atBoot = host.state === "creating" || host.state === "booting";
  // The owner's alert is the only other trace, and the record goes with
  // the host: the log keeps why a host was taken out.
  console.warn("[browser-pool] a host failed", {
    hostId: host.id,
    reason,
    state: host.state,
    vmId: host.vmId,
  });
  await writeHeld(
    host,
    {
      createBlockedUntil: atBoot
        ? new Date(now.getTime() + createCooldownMs)
        : host.createBlockedUntil,
      lastError: reason,
      state: "failed",
    },
    now
  );
  // Keyed by the VM, so every host that fails is told of.
  await alert(
    `browser-host-failed:${host.id}:${host.vmId ?? "no-vm"}`,
    [
      `Хост пула браузеров ${host.vmName} выведен из работы и будет удалён: ${reason}`,
      ...(atBoot
        ? [
            `Он не поднялся: новых хостов не будет ${String(createCooldownMs / 60_000)} минут. Проверь BROWSER_HOST_BUNDLE, BROWSER_SANDBOX_ROOTFS и доступ VM к зеркалам.`,
          ]
        : []),
    ].join("\n")
  );
}

/** Whether the host lacks the sandbox root errands start on now. */
function outdatedRoot(capacity: BrowserHostCapacity | null) {
  const rootfs = env.BROWSER_SANDBOX_ROOTFS;
  return (
    rootfs !== undefined &&
    capacity !== null &&
    !capacity.rootfsVersions.includes(rootfs.version)
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
    runtime: capacity.runtime ?? null,
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
