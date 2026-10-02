import { createHash } from "node:crypto";
import type * as timersModule from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as workerModule from "@agent/lib/browser-vm/worker";
import type { browserVms } from "@db/schema/browser-vms";
import type * as browserVmRecords from "@db/services/browser-vms";
import {
  browserVmTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

type BrowserVmRow = typeof browserVms.$inferSelect;

const workspaceId = "personal:0123456789abcdef0123456789abcdef";
const now = new Date("2026-09-30T12:00:00.000Z");
const code = new TextEncoder().encode('VERSION = "2026-09-30.1"\n');
const sha256 = createHash("sha256").update(code).digest("hex");
const published = `2026-09-30.1:workers/worker-2026-09-30.1.py:${sha256}`;
const settings = {
  ...browserVmTestEnvironment,
  BROWSER_STATE_BUCKET: "bro-state-test",
  BROWSER_VM_WORKER: published,
  CLOUDRU_S3_TENANT_ID: "test-tenant",
};

const records = vi.hoisted(() => ({
  listOpenBrowserVmRuns: vi.fn<typeof browserVmRecords.listOpenBrowserVmRuns>(),
  updateBrowserVm: vi.fn<typeof browserVmRecords.updateBrowserVm>(),
}));
const listWorkspacesHoldingBrowsers = vi.hoisted(() =>
  vi.fn<(workspaceIds: readonly string[], now?: Date) => Promise<string[]>>()
);
const worker = vi.hoisted(() => ({
  readBrowserVmWorkerHealth:
    vi.fn<typeof workerModule.readBrowserVmWorkerHealth>(),
  updateBrowserVmWorkerCode:
    vi.fn<typeof workerModule.updateBrowserVmWorkerCode>(),
}));
const alertOwner = vi.hoisted(() =>
  vi.fn<
    (
      key: string,
      text: string,
      options: { readonly repeatAfterMs: number }
    ) => Promise<boolean>
  >()
);
const sleep = vi.hoisted(() => vi.fn<(ms: number) => Promise<void>>());
/** Object Storage: what a presigned GET of the worker's key answers. */
const objectStorage = vi.hoisted(() =>
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
);

vi.mock("@db/services/browser-vms", () => records);
vi.mock("@db/services/browser-runs", () => ({
  listWorkspacesHoldingBrowsers,
}));
vi.mock("@agent/lib/browser-vm/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof workerModule>()),
  ...worker,
}));
vi.mock("@agent/lib/owner-alert", () => ({
  alertOwner,
  clearOwnerAlert: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof timersModule>()),
  setTimeout: sleep,
}));

function vmRow(overrides: Partial<BrowserVmRow> = {}) {
  return {
    bootDiskId: "disk-1",
    claimedAt: now,
    createdAt: now,
    floatingIpId: "fip-1",
    generation: 1,
    givenUpAt: null,
    healthFailures: 0,
    host: "45.132.176.116",
    hostId: null,
    image: "bro-browser-test-1",
    lastError: null,
    lastUsedAt: new Date(now.getTime() - 10 * 60_000),
    leaseUntil: new Date(now.getTime() + 120_000),
    parkFailures: 0,
    parkRetryAt: null,
    poweredOnAt: null,
    profileGeneration: 1,
    profileResetPending: false,
    proxyExit: null,
    proxySession: null,
    recoveries: 0,
    sandboxState: null,
    snapshotChunks: null,
    snapshotFormat: null,
    snapshotGeneration: null,
    snapshotKey: null,
    state: "ready",
    stateChangedAt: now,
    stopNotBefore: null,
    updatedAt: now,
    vmId: "vm-1",
    vmName: "bro-personal0123456789ab-1",
    workerFailedVersion: null,
    workerRolloutAt: null,
    workspaceId,
    ...overrides,
  } satisfies BrowserVmRow;
}

function health(version = "2026-09-29.1", busy = false) {
  return {
    busy,
    chrome: true,
    configured: true,
    generation: 1,
    image: "bro-browser-test-1",
    proxy: true,
    stage: null,
    uptimeSeconds: 120,
    worker: version,
  };
}

function openRun(createdAt: Date) {
  return {
    createdAt,
    error: null,
    finalUrl: null,
    finishedAt: null,
    id: `vm:${workspaceId}:r:1`,
    result: null,
    sessionId: `vm:${workspaceId}:s:1`,
    status: "running" as const,
    task: "Find the parcel",
    unreadMessages: null,
    updatedAt: now,
    workspaceId,
  };
}

async function loadRollout(overrides: Record<string, string> = {}) {
  return importWithSettings(
    { ...settings, ...overrides },
    async () => import("@agent/lib/browser-vm/rollout")
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", objectStorage);
  objectStorage.mockImplementation(async () => new Response(code));
  records.listOpenBrowserVmRuns.mockResolvedValue([]);
  records.updateBrowserVm.mockImplementation(async (_id, patch) => ({
    ...vmRow(),
    ...patch,
  }));
  listWorkspacesHoldingBrowsers.mockResolvedValue([]);
  worker.updateBrowserVmWorkerCode.mockResolvedValue();
  // Restarting once, then up in the new version.
  worker.readBrowserVmWorkerHealth
    .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
    .mockResolvedValue(health("2026-09-30.1"));
  alertOwner.mockResolvedValue(true);
  sleep.mockResolvedValue();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  clearBrowserVmSettings();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.resetModules();
});

const minutes = (count: number) => new Date(now.getTime() - count * 60_000);

describe("rolling a published worker out to a workspace's VM", () => {
  it("does nothing at all without BROWSER_VM_WORKER", async () => {
    const rollout = await loadRollout({ BROWSER_VM_WORKER: "" });

    expect(rollout.browserVmWorkerDue(vmRow(), health(), now)).toBeUndefined();
    expect(
      rollout.browserVmWorkerRollingOut(vmRow({ workerRolloutAt: now }), now)
    ).toBe(false);
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);
    expect(objectStorage).not.toHaveBeenCalled();
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
    expect(records.updateBrowserVm).not.toHaveBeenCalled();
  });

  it("leaves a worker that already runs the published version, or a newer one", async () => {
    const rollout = await loadRollout();

    for (const running of ["2026-09-30.1", "2026-09-30.2", "2026-10-05.1"]) {
      expect(
        rollout.browserVmWorkerDue(vmRow(), health(running), now)
      ).toBeUndefined();
    }
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health("2026-10-05.1"), now)
    ).resolves.toBe(false);
    // Older, or not dated at all: another version, which it replaces.
    for (const running of ["2026-09-29.9", "2025-12-31.10", "dev"]) {
      expect(
        rollout.browserVmWorkerDue(vmRow(), health(running), now)?.version
      ).toBe("2026-09-30.1");
    }
    expect(objectStorage).not.toHaveBeenCalled();
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
  });

  it("fetches the code by a presigned GET, checks it and hands it to an idle worker", async () => {
    const rollout = await loadRollout();
    const vm = vmRow();

    await expect(
      rollout.rollOutBrowserVmWorker(vm, health(), now)
    ).resolves.toBe(true);

    // The attempt is written down first, under the lease.
    expect(records.updateBrowserVm).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      { workerRolloutAt: now },
      now,
      vm.leaseUntil
    );
    const [url] = objectStorage.mock.calls[0] ?? [];
    expect(url).toMatch(
      /^https:\/\/s3\.cloud\.ru\/bro-state-test\/workers\/worker-2026-09-30\.1\.py\?/u
    );
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("test-tenant%3Atest-key-id");
    const [target, sent, checksum, timeoutMs] =
      worker.updateBrowserVmWorkerCode.mock.calls[0] ?? [];
    expect(target).toBe(vm);
    expect(sent).toEqual(code);
    expect(checksum).toBe(sha256);
    // The POST fits in the rollout's budget, which fits in the lease.
    expect(timeoutMs).toBeLessThanOrEqual(75_000);
    // Waited through the restart for the new version.
    expect(worker.readBrowserVmWorkerHealth).toHaveBeenCalledTimes(2);
    expect(alertOwner).not.toHaveBeenCalled();
  });

  it("sends nothing to the worker when the file does not match its checksum, and remembers the version", async () => {
    const rollout = await loadRollout();
    objectStorage.mockImplementation(
      async () => new Response("print('tampered')\n")
    );
    const vm = vmRow();

    await expect(
      rollout.rollOutBrowserVmWorker(vm, health(), now)
    ).resolves.toBe(false);

    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
    expect(records.updateBrowserVm).toHaveBeenLastCalledWith(
      workspaceId,
      { workerFailedVersion: "2026-09-30.1" },
      expect.any(Date),
      vm.leaseUntil
    );
    expect(alertOwner).toHaveBeenCalledOnce();
    const [key, text, options] = alertOwner.mock.calls[0] ?? [];
    expect(key).toBe("browser-vm-worker:2026-09-30.1");
    expect(text).toContain("sha256");
    expect(options?.repeatAfterMs).toBeGreaterThanOrEqual(7 * 24 * 60 * 60_000);
  });

  it("waits while a run is open, a page is kept, the worker is busy, or the VM was just handed out", async () => {
    const rollout = await loadRollout();

    records.listOpenBrowserVmRuns.mockResolvedValueOnce([openRun(now)]);
    await expect(rollout.browserVmIdleForWorker(vmRow(), now)).resolves.toBe(
      false
    );
    listWorkspacesHoldingBrowsers.mockResolvedValueOnce([workspaceId]);
    await expect(rollout.browserVmIdleForWorker(vmRow(), now)).resolves.toBe(
      false
    );
    records.listOpenBrowserVmRuns.mockRejectedValueOnce(new Error("db down"));
    await expect(rollout.browserVmIdleForWorker(vmRow(), now)).resolves.toBe(
      false
    );
    await expect(rollout.browserVmIdleForWorker(vmRow(), now)).resolves.toBe(
      true
    );

    expect(
      rollout.browserVmWorkerDue(vmRow(), health("2026-09-29.1", true), now)
    ).toBeUndefined();
    // An errand got the VM a moment ago and may still be setting it up.
    expect(
      rollout.browserVmWorkerDue(
        vmRow({ lastUsedAt: new Date(now.getTime() - 30_000) }),
        health(),
        now
      )
    ).toBeUndefined();

    expect(objectStorage).not.toHaveBeenCalled();
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
  });

  it("does not wait on a run record nobody read to its end for an hour", async () => {
    const rollout = await loadRollout();
    records.listOpenBrowserVmRuns.mockResolvedValue([openRun(minutes(120))]);

    await expect(rollout.browserVmIdleForWorker(vmRow(), now)).resolves.toBe(
      true
    );
  });

  it("does not try a version again on a VM where it failed", async () => {
    const rollout = await loadRollout();
    const vm = vmRow({ workerFailedVersion: "2026-09-30.1" });

    expect(rollout.browserVmWorkerDue(vm, health(), now)).toBeUndefined();
    await expect(
      rollout.rollOutBrowserVmWorker(vm, health(), now)
    ).resolves.toBe(false);
    expect(objectStorage).not.toHaveBeenCalled();
    // A newer publication is tried again.
    expect(
      rollout.browserVmWorkerDue(
        vmRow({ workerFailedVersion: "2026-09-29.9" }),
        health(),
        now
      )?.version
    ).toBe("2026-09-30.1");
  });

  it("remembers code the worker refused to load, and code that did not come up", async () => {
    const rollout = await loadRollout();
    const { BrowserVmWorkerError } =
      await import("@agent/lib/browser-vm/worker");
    worker.updateBrowserVmWorkerCode.mockRejectedValueOnce(
      new BrowserVmWorkerError(
        400,
        "/v1/admin/worker",
        "ModuleNotFoundError: No module named 'browser_use'"
      )
    );

    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);
    expect(records.updateBrowserVm).toHaveBeenLastCalledWith(
      workspaceId,
      { workerFailedVersion: "2026-09-30.1" },
      expect.any(Date),
      expect.any(Date)
    );

    // Taken, but the health check keeps answering the old version (rolled
    // back) until the wait is over: each poll's pause moves the clock.
    records.updateBrowserVm.mockClear();
    worker.readBrowserVmWorkerHealth.mockReset();
    worker.readBrowserVmWorkerHealth.mockResolvedValue(health());
    const start = Date.now();
    vi.spyOn(Date, "now").mockImplementation(
      () => start + sleep.mock.calls.length * 2_000
    );
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(true);
    expect(worker.readBrowserVmWorkerHealth.mock.calls.length).toBe(15);
    expect(records.updateBrowserVm).toHaveBeenLastCalledWith(
      workspaceId,
      { workerFailedVersion: "2026-09-30.1" },
      expect.any(Date),
      expect.any(Date)
    );
    expect(alertOwner).toHaveBeenCalledTimes(2);
    expect(
      alertOwner.mock.calls.every(
        ([key]) => key === "browser-vm-worker:2026-09-30.1"
      )
    ).toBe(true);
  });

  it("does not remember a refused key, a throttle or no answer, and waits a while before the next try", async () => {
    const rollout = await loadRollout();
    const { BrowserVmWorkerError } =
      await import("@agent/lib/browser-vm/worker");

    objectStorage
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(new Response("AccessDenied", { status: 403 }))
      .mockResolvedValueOnce(new Response("SlowDown", { status: 429 }));
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);
    // A run started between the checks: the worker says busy.
    worker.updateBrowserVmWorkerCode.mockRejectedValueOnce(
      new BrowserVmWorkerError(409, "/v1/admin/worker", '{"error":"busy"}')
    );
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);

    expect(worker.updateBrowserVmWorkerCode).toHaveBeenCalledOnce();
    expect(
      records.updateBrowserVm.mock.calls.map(([, patch]) => patch)
    ).toEqual(Array.from({ length: 4 }, () => ({ workerRolloutAt: now })));
    expect(alertOwner.mock.calls.map(([key]) => key)).toEqual(
      Array.from({ length: 3 }, () => "browser-vm-worker:2026-09-30.1:passing")
    );
    // Not tried again in every errand's path: only after a while.
    expect(
      rollout.browserVmWorkerDue(
        vmRow({ workerRolloutAt: minutes(5) }),
        health(),
        now
      )
    ).toBeUndefined();
    expect(
      rollout.browserVmWorkerDue(
        vmRow({ workerRolloutAt: minutes(20) }),
        health(),
        now
      )?.version
    ).toBe("2026-09-30.1");
  });

  it("remembers a publication Object Storage does not have", async () => {
    const rollout = await loadRollout();
    objectStorage.mockResolvedValueOnce(
      new Response("NoSuchKey", { status: 404 })
    );

    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);
    expect(records.updateBrowserVm).toHaveBeenLastCalledWith(
      workspaceId,
      { workerFailedVersion: "2026-09-30.1" },
      expect.any(Date),
      expect.any(Date)
    );
  });

  it("alerts a failure it remembers even after a passing one of the same version", async () => {
    const rollout = await loadRollout();
    // As the owner alert dedups: once per key.
    const sent = new Set<string>();
    alertOwner.mockImplementation(async (key) => {
      if (sent.has(key)) return false;
      sent.add(key);
      return true;
    });
    objectStorage.mockRejectedValueOnce(new Error("timeout"));
    await rollout.rollOutBrowserVmWorker(vmRow(), health(), now);
    objectStorage.mockResolvedValueOnce(new Response("tampered"));
    await rollout.rollOutBrowserVmWorker(vmRow(), health(), now);

    expect(alertOwner).toHaveBeenCalledTimes(2);
    expect([...sent]).toEqual([
      "browser-vm-worker:2026-09-30.1:passing",
      "browser-vm-worker:2026-09-30.1",
    ]);
  });

  it("tells an errand to wait only while another step is rolling out", async () => {
    const rollout = await loadRollout();
    const held = new Date(now.getTime() + 60_000);

    expect(
      rollout.browserVmWorkerRollingOut(
        vmRow({ leaseUntil: held, workerRolloutAt: minutes(0.5) }),
        now
      )
    ).toBe(true);
    // The lease is someone else's for another reason, or long past.
    expect(
      rollout.browserVmWorkerRollingOut(
        vmRow({ leaseUntil: held, workerRolloutAt: minutes(10) }),
        now
      )
    ).toBe(false);
    expect(
      rollout.browserVmWorkerRollingOut(
        vmRow({ leaseUntil: null, workerRolloutAt: minutes(0.5) }),
        now
      )
    ).toBe(false);
  });

  it("does not start without the bucket to fetch from", async () => {
    const rollout = await loadRollout({ BROWSER_STATE_BUCKET: "" });

    expect(rollout.browserVmWorkerDue(vmRow(), health(), now)).toBeUndefined();
    await expect(
      rollout.rollOutBrowserVmWorker(vmRow(), health(), now)
    ).resolves.toBe(false);
    expect(records.updateBrowserVm).not.toHaveBeenCalled();
    expect(alertOwner).not.toHaveBeenCalled();
  });

  it("leaves a sandbox of the pool alone", async () => {
    const rollout = await loadRollout();
    const sandbox = vmRow({ hostId: "bro-host-1", sandboxState: "running" });

    expect(rollout.browserVmWorkerDue(sandbox, health(), now)).toBeUndefined();
    await expect(
      rollout.rollOutBrowserVmWorker(sandbox, health(), now)
    ).resolves.toBe(false);
    expect(objectStorage).not.toHaveBeenCalled();
    expect(worker.updateBrowserVmWorkerCode).not.toHaveBeenCalled();
  });
});
